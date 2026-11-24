// Canvas Card Font 0.1.4 stores and scales the native card dimensions. Give
// those synchronous operations the same height the canvas file will save.
export class CanvasCardFontBridge {
  constructor(cards, patch) {
    this.cards = cards;
    this.patch = patch;
    this.controllers = new Map();
    this.active = new Set();
    this.restore = [];
  }

  connect(plugin) {
    if (this.plugin !== plugin) {
      this.disconnect();
      if (!(plugin?.views instanceof Map) || typeof plugin.snapshot !== "function" ||
          typeof plugin.paint !== "function" || typeof plugin.runCommand !== "function") return;
      this.attach(plugin);
    }
    if (!this.plugin) return;

    const current = new Set(this.plugin.views.values());
    for (const [controller, restore] of this.controllers) {
      if (current.has(controller)) continue;
      restore();
      this.controllers.delete(controller);
    }
    for (const controller of current) {
      if (this.controllers.has(controller) || typeof controller.paint !== "function") continue;
      const bridge = this;
      this.controllers.set(controller, this.patch(controller, "paint", original => function (node, ...args) {
        return bridge.withExpandedSize([node], () => original.call(this, node, ...args));
      }));
      // Its first scan may have run before the fold plugin connected.
      for (const node of controller.canvas.nodes.values()) {
        if (this.cards.get(node)?.expandedHeight) controller.appliedSizes?.delete(node);
      }
      controller.schedule?.(true);
    }
  }

  attach(plugin) {
    this.plugin = plugin;
    const bridge = this;
    this.restore = [
      this.patch(plugin, "snapshot", original => function (view, nodes) {
        return bridge.withExpandedSize(nodes, () => original.call(this, view, nodes));
      }),
      this.patch(plugin, "paint", original => function (key, ...args) {
        const [path, space, id] = JSON.parse(key);
        const nodes = [];
        for (const view of this.views.values()) {
          const scope = view.scope();
          if (scope?.[0] === path && scope[1] === space) nodes.push(view.canvas.nodes.get(id));
        }
        return bridge.withExpandedSize(nodes, () => original.call(this, key, ...args));
      }),
      this.patch(plugin, "runCommand", original => function (action, checking) {
        if (checking) return original.call(this, action, checking);
        const canvas = this.app.workspace.activeLeaf?.view?.canvas;
        return bridge.withExpandedSize(canvas?.nodes.values() ?? [], () => original.call(this, action, checking));
      }),
    ];
  }

  withExpandedSize(nodes, action) {
    const resized = [];
    for (const node of nodes) {
      const card = this.cards.get(node);
      if (!card?.expandedHeight || this.active.has(node)) continue;
      resized.push({ node, card, foldedHeight: node.height });
      this.active.add(node);
      node.height = card.expandedHeight;
    }
    try {
      return action();
    } finally {
      for (const { node, card, foldedHeight } of resized) {
        card.expandedHeight = node.height;
        node.height = foldedHeight;
        this.active.delete(node);
      }
    }
  }

  disconnect() {
    for (const restore of this.controllers.values()) restore();
    this.controllers.clear();
    for (const restore of this.restore) restore();
    this.restore = [];
    this.plugin = undefined;
  }
}
