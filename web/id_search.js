import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI.IDSearch.Lite",

    async setup() {
        // =========================
        // 1. Core State Management
        // =========================
        let currentNode = null;
        let selectedIndex = -1;
        let results = [];
        let searchHistory = [];
        let navMode = "chain"; 
        let isShowingHistory = false;

        const activeKeys = new Set();
        const highlightNodes = new Set();

        // =========================
        // 2. UI Construction
        // =========================
        const container = document.createElement("div");
        const input = document.createElement("input");
        const historyBtn = document.createElement("div");
        const dropdown = document.createElement("div");
        const leftBtn = document.createElement("button");
        const rightBtn = document.createElement("button");

        const commonStyle = { position: "fixed", zIndex: 10001, background: "#222", color: "#fff", border: "1px solid #555", borderRadius: "6px", fontSize: "12px" };
        Object.assign(container.style, { position: "fixed", top: "10px", right: "10px", display: "flex", zIndex: 10001 });
        Object.assign(input.style, { background: "#222", color: "#fff", border: "1px solid #555", borderRadius: "6px 0 0 6px", padding: "6px 10px", width: "240px", outline: "none", boxSizing: "border-box" });
        
        input.placeholder = "Search ID/Text; X+D+F to Re-anchor";

        Object.assign(historyBtn.style, { background: "#333", color: "#aaa", border: "1px solid #555", borderLeft: "none", borderRadius: "0 6px 6px 0", width: "26px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", userSelect: "none" });
        historyBtn.innerHTML = "▼";
        Object.assign(dropdown.style, commonStyle, { top: "42px", right: "10px", width: "266px", maxHeight: "400px", overflowY: "auto", display: "none", boxShadow: "0 10px 25px rgba(0,0,0,0.5)" });
        
        const btnStyle = { ...commonStyle, top: "10px", width: "32px", height: "32px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px" };
        Object.assign(leftBtn.style, btnStyle, { right: "315px" });
        Object.assign(rightBtn.style, btnStyle, { right: "280px" });
        leftBtn.innerHTML = "⬅️"; rightBtn.innerHTML = "➡️";

        container.append(input, historyBtn);
        document.body.append(container, dropdown, leftBtn, rightBtn);

        // =========================
        // 3. Helper Functions
        // =========================
        const clearVisuals = () => {
            highlightNodes.forEach(n => {
                if (n._origColor !== undefined) {
                    n.color = n._origColor; n.boxcolor = n._origBoxColor; n.bgcolor = n._origBgColor;
                    delete n._origColor; delete n._origBoxColor; delete n._origBgColor;
                }
            });
            highlightNodes.clear();
            app.canvas.draw(true, true);
        };

        const jumpTo = (node, isManual = false, matchedWidget = null) => {
            if (!node) return;
            clearVisuals();
            currentNode = node;
            input.value = String(node.id);

            if (isManual) {
                navMode = "chain";
                const entry = { id: String(node.id), title: node.title || node.type };
                searchHistory = [entry, ...searchHistory.filter(h => h.id !== entry.id)].slice(0, 20);
                
                if (matchedWidget) {
                    console.log(`%c[IDSearch] Matched Widget in Node ${node.id}: %c${matchedWidget.name}%c, Value: %c${matchedWidget.value}`, "color: #ccc;", "color: #FF9900; font-weight: bold;", "color: #ccc;", "color: #00FFCC;");
                }
            }

            app.canvas.centerOnNode(node);
            app.canvas.selectNode(node, false);
            
            const old = node.color; let c = 0;
            const f = () => { if (c < 3) { node.color = "#FF9900"; app.canvas.draw(true, true); setTimeout(() => { node.color = old; app.canvas.draw(true, true); setTimeout(f, 120); }, 120); c++; } };
            f();
        };

        const navigate = (dir) => {
            if (!currentNode) return;
            let targets = [];
            const isDown = dir === "down";
            const side = isDown ? currentNode.outputs : currentNode.inputs;
            side?.forEach(slot => {
                const links = isDown ? slot.links : [slot.link];
                links?.forEach(lid => {
                    const l = app.graph.links[lid];
                    if (l) {
                        const n = app.graph.getNodeById(isDown ? l.target_id : l.origin_id);
                        if(n) targets.push(n);
                    }
                });
            });
            const fresh = [...new Set(targets.filter(Boolean))];
            if (!fresh.length) return;
            jumpTo(fresh[0], false);
        };

        // =========================
        // 4. Enhanced Search Logic
        // =========================
        const renderDropdown = (items) => {
            dropdown.innerHTML = "";
            items.forEach((data, index) => {
                const item = document.createElement("div");
                item.textContent = `[${data.id}] ${data.title || data.type}`;
                Object.assign(item.style, { padding: "8px", cursor: "pointer", borderBottom: "1px solid #333", background: index === selectedIndex ? "#FF990044" : "transparent" });
                item._matchedWidget = data._matchedWidget; 

                item.onmousedown = (e) => { 
                    e.preventDefault(); 
                    const n = app.graph.getNodeById(data.id);
                    if(n) jumpTo(n, true, item._matchedWidget);
                    dropdown.style.display = "none"; 
                };
                dropdown.appendChild(item);
            });
            dropdown.style.display = items.length ? "block" : "none";
        };

        const updateSearch = () => {
            isShowingHistory = false;
            const val = input.value.trim().toLowerCase();
            if (!val) { dropdown.style.display = "none"; return; }
            const nodes = app.graph?._nodes || [];

            results = nodes.map(n => {
                let matchedWidget = null;
                if (n.widgets) {
                    matchedWidget = n.widgets.find(w => String(w.value).toLowerCase().includes(val));
                }
                const matchType = (n.title || n.type || "").toLowerCase().includes(val);
                const matchId = String(n.id).includes(val);
                if (matchId || matchType || matchedWidget) {
                    return { ...n, _matchedWidget: matchedWidget };
                }
                return null;
            }).filter(Boolean);

            results.sort((a,b) => String(a.id) === val ? -1 : String(a.id).length - String(b.id).length).slice(0, 20);
            selectedIndex = -1;
            renderDropdown(results);
        };

        // =========================
        // 5. Input & Keyboard Events
        // =========================
        input.addEventListener("input", updateSearch);
        window.addEventListener("keydown", (e) => {
            const key = e.key.toLowerCase(); activeKeys.add(key);
            const isXD = activeKeys.has('x') && activeKeys.has('d');
            
            if (isXD) {
                // Focus Search Bar
                if (key === 'f') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    setTimeout(() => {
                        input.focus();
                        input.select();
                    }, 10);
                }
                // Relocate Anchor
                if (key === 'v') {
                    e.preventDefault(); e.stopImmediatePropagation();
                    requestAnimationFrame(() => {
                        const id = prompt("Enter Node ID to relocate start node:", currentNode ? currentNode.id : "");
                        if (id) { const n = app.graph.getNodeById(id.trim()); if (n) jumpTo(n, true); }
                    });
                }
                if (key === 'arrowleft') { e.preventDefault(); navigate("up"); }
                if (key === 'arrowright') { e.preventDefault(); navigate("down"); }
            }

            if (dropdown.style.display === "block") {
                const list = isShowingHistory ? searchHistory : results;
                if (list.length > 0) {
                    if (e.key === "ArrowDown") {
                        e.preventDefault(); selectedIndex = (selectedIndex + 1) % list.length; renderDropdown(list);
                    } else if (e.key === "ArrowUp") {
                        e.preventDefault(); selectedIndex = (selectedIndex - 1 + list.length) % list.length; renderDropdown(list);
                    } else if (e.key === "Enter") {
                        e.preventDefault();
                        const targetData = selectedIndex >= 0 ? list[selectedIndex] : list[0];
                        if (targetData) {
                            const n = app.graph.getNodeById(targetData.id);
                            if(n) jumpTo(n, true, targetData._matchedWidget);
                        }
                        dropdown.style.display = "none"; input.blur();
                    }
                }
            } else if (e.key === "Enter" && document.activeElement === input) {
                const n = app.graph.getNodeById(input.value.trim()); if (n) jumpTo(n, true);
            }
        }, true);

        window.addEventListener("keyup", (e) => activeKeys.delete(e.key.toLowerCase()), true);

        // =========================
        // 6. UI Helpers & Cleanup
        // =========================
        historyBtn.onclick = (e) => {
            e.stopPropagation(); isShowingHistory = !isShowingHistory; selectedIndex = -1;
            renderDropdown(isShowingHistory ? searchHistory : []); input.focus();
        };
        leftBtn.onclick = () => navigate("up");
        rightBtn.onclick = () => navigate("down");
        document.addEventListener("mousedown", (e) => { if (!container.contains(e.target) && !dropdown.contains(e.target)) dropdown.style.display = "none"; });

        const orgSerialize = app.graph.serialize;
        app.graph.serialize = function() {
            app.graph._nodes?.forEach(n => { if (n._origColor !== undefined) { n.color = n._origColor; n.boxcolor = n._origBoxColor; n.bgcolor = n._origBgColor; } });
            return orgSerialize.apply(this, arguments);
        };
    }
});