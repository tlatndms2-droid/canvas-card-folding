import { Modal, Plugin, setIcon } from "obsidian";
import { firstHeading, prependHeading } from "./heading.js";

const FOLD_KEY = "canvasCardFolding";
const FOLD_VERSION = 2;
const MIN_FOLDED_HEIGHT = 48;
const FOLDED_TITLE_PADDING = 16;
const FOLDED_CLASS = "canvas-card-folding-folded";

function patch(object, name, wrap) {
  const original = object[name];
  const hadOwnProperty = Object.hasOwn(object, name);
  const replacement = wrap(original);
  object[name] = replacement;
  return () => {
    if (object[name] !== replacement) return;
    if (hadOwnProperty) object[name] = original;
    else delete object[name];
  };
}

function isMarkdownCard(data) {
  return data.type === "file" && /\.md$/i.test(data.file ?? "");
}

function canFold(data) {
  return data.type === "text" || isMarkdownCard(data);
}

function foldState(data) {
  const state = data[FOLD_KEY];
  return state?.version === FOLD_VERSION && typeof state.folded === "boolean" && canFold(data) ? state : null;
}

function isFolded(data) {
  const state = foldState(data);
  return state?.folded === true && Number.isFinite(data.height) && data.height > 0 &&
    (isMarkdownCard(data) || (typeof state.title === "string" && Boolean(state.title.trim())));
}

class TitleModal extends Modal {
  constructor(app, submit, didClose, initialTitle) {
    super(app);
    this.submit = submit;
    this.didClose = didClose;
    this.initialTitle = initialTitle;
  }

  onOpen() {
    this.setTitle("카드 제목 입력");
    const form = this.contentEl.createEl("form", { cls: "canvas-card-folding-form" });
    const label = form.createEl("label", { text: "접힌 카드에 표시할 제목" });
    const input = label.createEl("input", { attr: { type: "text", required: "" } });
    input.value = this.initialTitle;
    const actions = form.createDiv("modal-button-container");
    actions.createEl("button", { text: "취소", attr: { type: "button" } }).onclick = () => this.close();
    actions.createEl("button", { text: "접기", cls: "mod-cta", attr: { type: "submit" } });
    input.addEventListener("input", () => input.setCustomValidity(""));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const title = input.value.replace(/\s+/g, " ").trim();
      if (!title) {
        input.setCustomValidity("제목을 입력해 주세요.");
        input.reportValidity();
        return;
      }
      this.close();
      this.submit(title);
    });
    input.focus();
  }

  onClose() {
    this.contentEl.empty();
    this.didClose();
  }
}

export default class CanvasCardFolding extends Plugin {
  canvases = new Map();
  cards = new WeakMap();
  dialogs = new Set();

  onload() {
    const connect = () => this.connectCanvases();
    this.registerEvent(this.app.workspace.on("file-open", connect));
    this.registerEvent(this.app.workspace.on("layout-change", connect));
    this.registerEvent(this.app.workspace.on("active-leaf-change", connect));
    this.app.workspace.onLayoutReady(connect);
  }

  onunload() {
    for (const dialog of this.dialogs) dialog.close();
    for (const canvas of this.canvases.keys()) this.disconnect(canvas);
  }

  connectCanvases() {
    const open = new Set();
    for (const { view } of this.app.workspace.getLeavesOfType("canvas")) {
      const canvas = view.canvas;
      if (!canvas?.nodes || typeof canvas.addNode !== "function" || typeof canvas.importData !== "function") continue;
      if (!canvas.menu?.menuEl || typeof canvas.menu.render !== "function") continue;
      open.add(canvas);
      if (!this.canvases.has(canvas)) this.connect(canvas);
    }
    for (const canvas of this.canvases.keys()) {
      if (!open.has(canvas)) this.disconnect(canvas);
    }
  }

  connect(canvas) {
    const plugin = this;
    const toolbarButton = this.createToolbarButton(canvas);
    const restore = [
      patch(canvas, "addNode", original => function (node, ...args) {
        const result = original.call(this, node, ...args);
        plugin.connectCard(node);
        return result;
      }),
      patch(canvas, "importData", original => function (data, replace, ...args) {
        // A pasted card is a new card. Loading the canvas and applying history
        // both use replace=true and keep the saved opt-in.
        if (replace === false && Array.isArray(data?.nodes)) {
          data = {
            ...data,
            nodes: data.nodes.map(node => {
              if (!Object.hasOwn(node, FOLD_KEY) || this.nodes.has(node.id)) return node;
              const { [FOLD_KEY]: previousFold, ...copy } = node;
              return copy;
            }),
          };
        }
        return original.call(this, data, replace, ...args);
      }),
      patch(canvas.menu, "render", original => function (...args) {
        const result = original.apply(this, args);
        // Appending a button changes the measured width of the native toolbar.
        if (plugin.renderToolbarButton(canvas, toolbarButton)) original.call(this, false);
        return result;
      }),
      () => toolbarButton.remove(),
    ];
    this.canvases.set(canvas, restore);
    for (const node of canvas.nodes.values()) this.connectCard(node);
    canvas.menu.render(false);
  }

  disconnect(canvas) {
    for (const restore of this.canvases.get(canvas)) restore();
    this.canvases.delete(canvas);
    for (const node of canvas.nodes.values()) {
      const card = this.cards.get(node);
      if (!card) continue;
      for (const restore of card.restore) restore();
      card.titleObserver?.disconnect();
      card.button?.remove();
      card.title?.remove();
      node.nodeEl.classList.remove(FOLDED_CLASS);
      if (card.expandedHeight) node.resize({ width: node.width, height: card.expandedHeight });
      this.cards.delete(node);
    }
  }

  connectCard(node) {
    if (this.cards.has(node)) return;
    const data = node.getData();
    if (data.type !== "text" && data.type !== "file") return;

    const plugin = this;
    const card = { expandedHeight: null, restore: [] };
    this.cards.set(node, card);
    card.restore = [
      patch(node, "getData", original => function (...args) {
        const data = original.apply(this, args);
        // Keep the standard canvas height useful even without this plugin.
        if (card.expandedHeight) data.height = card.expandedHeight;
        return data;
      }),
      patch(node, "setData", original => function (data, ...args) {
        const hadArrow = Boolean(card.button?.parentNode);
        const folding = isFolded(data);
        const foldedHeight = card.expandedHeight ? this.height : MIN_FOLDED_HEIGHT;
        const result = original.call(this, folding ? { ...data, height: foldedHeight } : data, ...args);
        card.expandedHeight = folding ? data.height : null;
        plugin.renderCard(this, card, data);
        if (hadArrow !== Boolean(card.button?.parentNode) && this.canvas.selection.has(this)) {
          this.canvas.markDirty(this);
        }
        return result;
      }),
      patch(node, "render", original => function (...args) {
        const result = original.apply(this, args);
        plugin.renderCard(this, card, this.getData());
        return result;
      }),
      patch(node, "destroy", original => function (...args) {
        card.titleObserver?.disconnect();
        return original.apply(this, args);
      }),
      patch(node, "startEditing", original => function (...args) {
        if (!card.expandedHeight) return original.apply(this, args);
      }),
      patch(node, "setIsEditing", original => function (...args) {
        const wasEditing = this.isEditing;
        const result = original.apply(this, args);
        if (wasEditing !== this.isEditing && this.canvas.selection.has(this)) this.canvas.markDirty(this);
        return result;
      }),
      patch(node, "onResizePointerdown", original => function (event, direction, ...args) {
        if (card.expandedHeight) {
          direction = direction.match(/left|right/)?.[0];
          if (!direction) return;
        }
        return original.call(this, event, direction, ...args);
      }),
      patch(node, "onResizeDblclick", original => function (...args) {
        if (!card.expandedHeight) return original.apply(this, args);
      }),
    ];
    if (isFolded(data)) node.setData(data);
    else this.renderCard(node, card, data);
  }

  renderCard(node, card, data) {
    const element = node.nodeEl;
    if (!foldState(data)) {
      card.titleObserver?.disconnect();
      card.titleLabel = null;
      card.button?.remove();
      card.title?.remove();
      element.classList.remove(FOLDED_CLASS);
      return;
    }
    if (!card.button) {
      card.button = element.ownerDocument.createElement("button");
      card.button.type = "button";
      card.button.className = "canvas-card-folding-button";
      card.button.addEventListener("pointerdown", event => event.stopPropagation());
      card.button.addEventListener("dblclick", event => event.stopPropagation());
      card.button.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      });
      card.button.addEventListener("click", event => {
        event.stopPropagation();
        this.toggleCard(node);
      });
      card.title = element.ownerDocument.createElement("div");
      card.title.className = "canvas-card-folding-title";
    }

    if (card.button.parentNode !== element) element.append(card.title, card.button);
    const folded = Boolean(card.expandedHeight);
    const foldedTitle = folded
      ? data.type === "text"
        ? data[FOLD_KEY].title
        : data.file.split("/").pop().slice(0, -3)
      : "";
    element.classList.toggle(FOLDED_CLASS, folded);
    let titleStyle;
    if (folded) {
      titleStyle = data.type === "text" ? this.getFirstHeading(node, data.text ?? "")?.level : "file";
    }
    this.renderTitle(node, card, foldedTitle, titleStyle);

    const label = folded ? "카드 펼치기" : "카드 접기";
    if (card.button.getAttribute("aria-label") !== label) {
      card.button.setAttribute("aria-label", label);
      card.button.setAttribute("aria-expanded", String(!folded));
      card.button.title = label;
      setIcon(card.button, folded ? "chevron-right" : "chevron-down");
    }
  }

  getFirstHeading(node, text) {
    const card = this.cards.get(node);
    if (card.headingSource !== text) {
      card.heading = firstHeading(text, node.nodeEl.ownerDocument);
      card.headingSource = text;
    }
    return card.heading;
  }

  renderTitle(node, card, title, style) {
    if (!card.titleLabel || card.titleStyle !== style) {
      card.titleObserver?.disconnect();
      card.titleStyle = style;
      const doc = card.title.ownerDocument;
      const label = doc.createElement(style === "file" ? "div" : style ? `h${style}` : "span");
      if (style === "file") label.className = "inline-title";
      card.title.classList.toggle("markdown-rendered", Boolean(style));
      card.title.replaceChildren(label);
      card.titleLabel = label;
      if (style) {
        const { ResizeObserver } = label.ownerDocument.defaultView;
        card.titleObserver ??= new ResizeObserver(([entry]) => {
          if (!card.expandedHeight || entry.target !== card.titleLabel || !entry.target.isConnected || !entry.contentRect.height) return;
          const height = Math.max(MIN_FOLDED_HEIGHT, Math.ceil(entry.contentRect.height + FOLDED_TITLE_PADDING));
          if (node.height !== height) node.resize({ width: node.width, height });
        });
        card.titleObserver.observe(label);
      } else if (card.expandedHeight && node.height !== MIN_FOLDED_HEIGHT) {
        node.resize({ width: node.width, height: MIN_FOLDED_HEIGHT });
      }
    }
    if (card.titleLabel.textContent !== title) {
      card.titleLabel.textContent = title;
      card.title.title = title;
    }
  }

  selectedCard(canvas) {
    if (canvas.readonly || canvas.isDragging || canvas.selection.size !== 1) return null;
    const [node] = canvas.selection;
    if (!this.cards.has(node) || node.isEditing || canvas.nodes.get(node.id) !== node) return null;
    return canFold(node.getData()) ? node : null;
  }

  createToolbarButton(canvas) {
    const button = canvas.menu.menuEl.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "clickable-icon canvas-card-folding-toolbar-button";
    button.setAttribute("aria-label", "카드 접기 설정");
    setIcon(button, "fold-vertical");
    button.addEventListener("pointerdown", event => event.stopPropagation());
    button.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    button.addEventListener("click", event => {
      event.stopPropagation();
      this.toggleFeature(canvas);
    });
    return button;
  }

  renderToolbarButton(canvas, button) {
    const menu = canvas.menu;
    const node = this.selectedCard(canvas);
    if (!node || menu.containerEl.parentNode !== canvas.wrapperEl) {
      const hadButton = Boolean(button.parentNode);
      button.remove();
      return hadButton && menu.containerEl.parentNode === canvas.wrapperEl;
    }
    const applied = Boolean(foldState(node.getData()));
    button.title = applied ? "접기 없애기" : "접기 만들기";
    button.setAttribute("aria-pressed", String(applied));
    if (menu.menuEl.lastElementChild === button) return false;
    menu.menuEl.append(button);
    return true;
  }

  toggleFeature(canvas) {
    const node = this.selectedCard(canvas);
    if (!node) return;
    const data = node.getData();
    if (!foldState(data)) {
      this.foldCard(node, data);
      return;
    }
    delete data[FOLD_KEY];
    node.setData(data);
    canvas.requestSave();
  }

  toggleCard(node) {
    const { canvas } = node;
    if (canvas.readonly || node.isEditing || canvas.nodes.get(node.id) !== node) return;
    const data = node.getData();
    if (!foldState(data)) return;
    if (this.cards.get(node)?.expandedHeight) {
      this.saveFoldState(node, data, false);
    } else {
      this.foldCard(node, data);
    }
  }

  foldCard(node, data) {
    if (isMarkdownCard(data)) {
      this.saveFoldState(node, data, true);
      return;
    }
    const { canvas } = node;
    const heading = this.getFirstHeading(node, data.text ?? "");
    if (heading) {
      this.saveFoldState(node, data, true, heading.text);
      return;
    }
    // Offer the previous title when applying folding to a legacy card.
    const oldState = data[FOLD_KEY];
    const initialTitle = oldState?.version === 1 && typeof oldState.title === "string" ? oldState.title : "";
    const wasApplied = Boolean(foldState(data));
    const dialog = new TitleModal(this.app, title => {
      if (canvas.readonly || node.isEditing || node.destroyed || canvas.nodes.get(node.id) !== node || !this.cards.has(node)) return;
      const current = node.getData();
      if (current.type !== "text" || isFolded(current) || Boolean(foldState(current)) !== wasApplied) return;
      const text = current.text ?? "";
      const heading = this.getFirstHeading(node, text);
      if (!heading) current.text = prependHeading(text, title);
      this.saveFoldState(node, current, true, heading?.text ?? title);
    }, () => this.dialogs.delete(dialog), initialTitle);
    this.dialogs.add(dialog);
    dialog.open();
  }

  saveFoldState(node, data, folded, title) {
    const state = { version: FOLD_VERSION, folded };
    if (title !== undefined) state.title = title;
    node.setData({ ...data, [FOLD_KEY]: state });
    node.canvas.requestSave();
  }
}
