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
        // 3. Graph / Node Helpers
        // =========================

        // IMPORTANT:
        // app.graph is not sufficient for Subgraphs. The active canvas graph is
        // app.canvas.graph, and every Subgraph owns its own _nodes / links.
        const getActiveGraph = () => app.canvas?.graph || app.graph;

        // Recursively walk Root -> Subgraph -> Nested Subgraph -> ...
        // A Subgraph can be nested many levels deep, so do not stop at one level.
        const walkGraphs = (graph, callback, path = [], visited = new Set()) => {
            if (!graph || visited.has(graph)) return;
            visited.add(graph);

            callback(graph, path);

            const nodes = graph._nodes || graph.nodes || [];
            for (const node of nodes) {
                if (node?.isSubgraphNode?.() && node.subgraph) {
                    walkGraphs(
                        node.subgraph,
                        callback,
                        [...path, node],
                        visited
                    );
                }
            }
        };

        // Find the chain of SubgraphNodes from Root -> target graph.
        // Example:
        // Root -> Subgraph B -> Subgraph D
        // returns [SubgraphNode(B), SubgraphNode(D)]
        const findGraphPath = (rootGraph, targetGraph) => {
            if (!rootGraph || !targetGraph) return null;
            if (rootGraph === targetGraph) return [];

            let found = null;

            walkGraphs(rootGraph, (graph, path) => {
                if (!found && graph === targetGraph) {
                    found = path;
                }
            });

            return found;
        };

        // Enter a target graph through ComfyUI's normal subgraph navigation.
        // We open each level in order so the canvas navigation stack remains valid.
        const openGraphPath = (targetGraph) => {
            const canvas = app.canvas;

            if (!canvas || !targetGraph) {
                return false;
            }

            const rootGraph = app.graph || canvas.graph;
            const path = findGraphPath(rootGraph, targetGraph);

            if (!path) {
                console.warn(
                    "[IDSearch] Cannot find graph path to target graph."
                );
                return false;
            }

            // Already at the target graph.
            if (canvas.graph === targetGraph) {
                return true;
            }

            // ---------------------------------------------------------
            // Always return to Root first.
            //
            // Do NOT rely on canvas.subgraph being truthy here.
            // The reliable condition is simply whether the active
            // graph is different from the root graph.
            // ---------------------------------------------------------
            let guard = 0;

            while (
                canvas.graph &&
                canvas.graph !== rootGraph &&
                guard++ < 1000
            ) {
                if (typeof canvas.closeSubgraph !== "function") {
                    break;
                }

                const beforeGraph = canvas.graph;

                canvas.closeSubgraph();

                // Prevent an infinite loop if the frontend refuses
                // to change the active graph.
                if (canvas.graph === beforeGraph) {
                    console.warn(
                        "[IDSearch] closeSubgraph() did not change the active graph."
                    );
                    break;
                }
            }

            // Fallback for frontends where closeSubgraph() cannot
            // restore the root graph completely.
            if (
                canvas.graph !== rootGraph &&
                typeof canvas.setGraph === "function"
            ) {
                canvas.setGraph(rootGraph);
            }
            
            // ---------------------------------------------------------
            // Enter the target graph level by level.
            // Example:
            // Root -> Subgraph A -> Subgraph B
            // ---------------------------------------------------------
            for (const subgraphNode of path) {
                const subgraph = subgraphNode?.subgraph;

                if (!subgraph) {
                    console.warn(
                        "[IDSearch] SubgraphNode has no subgraph."
                    );
                    return false;
                }

                if (canvas.graph === subgraph) {
                    continue;
                }

                if (typeof canvas.openSubgraph === "function") {
                    canvas.openSubgraph(subgraph);
                } else if (typeof canvas.setGraph === "function") {
                    canvas.setGraph(subgraph);
                } else {
                    console.warn(
                        "[IDSearch] Canvas has no Subgraph navigation API."
                    );
                    return false;
                }
            }

            return canvas.graph === targetGraph;
        };

        const getGraphPathLabels = (graphPath) => {
            if (!graphPath?.length) return "Root";
            return ["Root", ...graphPath.map(node =>
                node?.title || node?.name || node?.type || `Subgraph ${node?.id ?? "?"}`
            )].join(" / ");
        };

        const getNodeGraphPath = (node) => {
            if (!node) return [];
            const rootGraph = app.graph;
            return findGraphPath(rootGraph, node.graph) || [];
        };

        const getNodeLocationKey = (node) => {
            if (!node) return "";
            const graph = node.graph;
            const graphId = graph?.id ?? "root";
            return `${String(graphId)}:${String(node.id)}`;
        };

        const clearVisuals = () => {
            highlightNodes.forEach(n => {
                if (n._origColor !== undefined) {
                    n.color = n._origColor;
                    n.boxcolor = n._origBoxColor;
                    n.bgcolor = n._origBgColor;
                    delete n._origColor;
                    delete n._origBoxColor;
                    delete n._origBgColor;
                }
            });
            highlightNodes.clear();
            app.canvas.draw(true, true);
        };

        // jumpTo now knows BOTH the node and its owning graph.
        const jumpTo = (node, isManual = false, matchedWidget = null) => {
            if (!node) return;

            clearVisuals();

            // Enter the correct nested Subgraph before trying to center/select.
            if (!openGraphPath(node.graph)) return;

            currentNode = node;
            input.value = String(node.id);

            if (isManual) {
                navMode = "chain";

                const graphPath = getNodeGraphPath(node);
                const locationKey = getNodeLocationKey(node);

                const entry = {
                    id: String(node.id),
                    title: node.title || node.type,
                    graph: node.graph,
                    graphPath,
                    graphPathLabel: getGraphPathLabels(graphPath),
                    locationKey
                };

                searchHistory = [
                    entry,
                    ...searchHistory.filter(h => h.locationKey !== locationKey)
                ].slice(0, 20);

                if (matchedWidget) {
                    console.log(
                        `%c[IDSearch] Matched Widget in Node ${node.id}: ` +
                        `%c${matchedWidget.name}%c, Value: %c${matchedWidget.value}`,
                        "color: #ccc;",
                        "color: #FF9900; font-weight: bold;",
                        "color: #ccc;",
                        "color: #00FFCC;"
                    );
                }
            }

            app.canvas.centerOnNode(node);
            app.canvas.selectNode(node, false);

            const old = node.color;
            let c = 0;
            const f = () => {
                if (c < 3) {
                    node.color = "#FF9900";
                    app.canvas.draw(true, true);
                    setTimeout(() => {
                        node.color = old;
                        app.canvas.draw(true, true);
                        setTimeout(f, 120);
                        c++;
                    }, 120);
                }
            };
            f();
        };

        // Navigation must use the graph that owns currentNode.
        // Never use app.graph.links for a node inside a Subgraph.
        const navigate = (dir) => {
            if (!currentNode) {
                return;
            }

            const graph =
                currentNode.graph ||
                getActiveGraph();

            if (!graph) {
                return;
            }

            const isDown = dir === "down";
            const targets = [];
            const links = graph.links;

            if (!links) {
                return;
            }

            // ---------------------------------------------------------
            // Follow the actual graph links, rather than relying only
            // on the current node's output/input slot arrays.
            //
            // This guarantees: 161 -> 151 -> 145
            // instead of accidentally jumping 161 -> 145.
            // ---------------------------------------------------------
            const addLinkTarget = (link) => {
                if (!link) {
                    return;
                }

                const targetId = isDown
                    ? link.target_id
                    : link.origin_id;

                if (
                    targetId === undefined ||
                    targetId === null
                ) {
                    return;
                }

                const target =
                    graph.getNodeById(targetId);

                if (target) {
                    targets.push(target);
                }
            };

            // Current ComfyUI uses a Map for graph.links.
            // Keep object support as a compatibility fallback.
            if (typeof links.forEach === "function") {
                links.forEach((link) => {
                    if (!link) {
                        return;
                    }

                    const matches = isDown
                        ? link.origin_id === currentNode.id
                        : link.target_id === currentNode.id;

                    if (matches) {
                        addLinkTarget(link);
                    }
                });
            } else {
                Object.values(links).forEach((link) => {
                    if (!link) {
                        return;
                    }

                    const matches = isDown
                        ? link.origin_id === currentNode.id
                        : link.target_id === currentNode.id;

                    if (matches) {
                        addLinkTarget(link);
                    }
                });
            }

            const fresh = [
                ...new Set(
                    targets.filter(Boolean)
                )
            ];

            if (!fresh.length) {
                return;
            }

            // Only move one actual link at a time.
            jumpTo(fresh[0], false);
        };
        // =========================
        // 4. Enhanced Search Logic
        // =========================

        const renderDropdown = (items) => {
            dropdown.innerHTML = "";

            items.forEach((data, index) => {
                const item = document.createElement("div");

                const location = data.graphPathLabel
                    ? ` ↳ ${data.graphPathLabel}`
                    : "";

                item.textContent =
                    `[${data.id}] ${data.title || data.type}${location}`;

                Object.assign(item.style, {
                    padding: "8px",
                    cursor: "pointer",
                    borderBottom: "1px solid #333",
                    background: index === selectedIndex
                        ? "#FF990044"
                        : "transparent"
                });

                item._matchedWidget = data._matchedWidget;

                item.onmousedown = (e) => {
                    e.preventDefault();

                    jumpTo(
                        data.node,
                        true,
                        item._matchedWidget
                    );

                    dropdown.style.display = "none";
                };

                dropdown.appendChild(item);
            });

            dropdown.style.display = items.length ? "block" : "none";
        };

        const updateSearch = () => {
            isShowingHistory = false;

            const val = input.value.trim().toLowerCase();

            if (!val) {
                dropdown.style.display = "none";
                return;
            }

            results = [];

            // Search ROOT + every nested Subgraph recursively.
            walkGraphs(app.graph, (graph, graphPath) => {
                const nodes = graph?._nodes || graph?.nodes || [];

                nodes.forEach(n => {
                    let matchedWidget = null;

                    if (n.widgets) {
                        matchedWidget = n.widgets.find(w =>
                            String(w.value).toLowerCase().includes(val)
                        );
                    }

                    const matchType =
                        (n.title || n.type || "")
                            .toLowerCase()
                            .includes(val);

                    const matchId =
                        String(n.id)
                            .toLowerCase()
                            .includes(val);

                    if (matchId || matchType || matchedWidget) {
                        results.push({
                            node: n,
                            id: String(n.id),
                            title: n.title,
                            type: n.type,
                            graph,
                            graphPath,
                            graphPathLabel: getGraphPathLabels(graphPath),
                            _matchedWidget: matchedWidget,
                            locationKey: getNodeLocationKey(n)
                        });
                    }
                });
            });

            results.sort((a, b) => {
                const aExact = String(a.id).toLowerCase() === val;
                const bExact = String(b.id).toLowerCase() === val;

                if (aExact !== bExact) return aExact ? -1 : 1;

                const lengthDiff =
                    String(a.id).length - String(b.id).length;

                if (lengthDiff !== 0) return lengthDiff;

                return a.graphPath.length - b.graphPath.length;
            });

            results = results.slice(0, 20);

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
                        if (id) {
                            const matches = [];
                            walkGraphs(app.graph, (graph) => {
                                const n = graph.getNodeById(id.trim());
                                if (n) matches.push(n);
                            });

                            if (matches.length === 1) {
                                jumpTo(matches[0], true);
                            } else if (matches.length > 1) {
                                // If IDs collide, prefer the node in the currently
                                // active graph. Otherwise ask the user to use Search.
                                const active = getActiveGraph();
                                const local = matches.find(n => n.graph === active);
                                if (local) {
                                    jumpTo(local, true);
                                } else {
                                    console.warn(
                                        `[IDSearch] Node ID ${id.trim()} exists in multiple graphs. ` +
                                        "Use the search dropdown to choose the exact location."
                                    );
                                }
                            }
                        }
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
                            if (targetData.node) {
                                jumpTo(
                                    targetData.node,
                                    true,
                                    targetData._matchedWidget
                                );
                            }
                        }
                        dropdown.style.display = "none"; input.blur();
                    }
                }
            } else if (e.key === "Enter" && document.activeElement === input) {
                const id = input.value.trim();
                const matches = [];
                walkGraphs(app.graph, (graph) => {
                    const n = graph.getNodeById(id);
                    if (n) matches.push(n);
                });

                if (matches.length === 1) {
                    jumpTo(matches[0], true);
                } else if (matches.length > 1) {
                    const active = getActiveGraph();
                    const local = matches.find(n => n.graph === active);
                    if (local) jumpTo(local, true);
                }
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
            walkGraphs(this, (graph) => {
                graph._nodes?.forEach(n => {
                    if (n._origColor !== undefined) {
                        n.color = n._origColor;
                        n.boxcolor = n._origBoxColor;
                        n.bgcolor = n._origBgColor;
                    }
                });
            });
            return orgSerialize.apply(this, arguments);
        };
    }
});