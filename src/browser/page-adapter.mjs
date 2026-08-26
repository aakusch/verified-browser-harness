// This function is serialized and evaluated inside the active browser page. Keep every
// helper self-contained and avoid references to module scope.
export async function pageBridgeOperation(request) {
  const profile = {
    cardSelector: request.profile?.cardSelector || "[data-task-card]",
    editorSelector:
      request.profile?.editorSelector ||
      "[data-code-editor], textarea, .CodeMirror, .cm-editor, .monaco-editor, [contenteditable='true']",
    titleSelector:
      request.profile?.titleSelector ||
      "[data-task-title], h1, h2, h3, h4, h5, h6",
    promptSelector: request.profile?.promptSelector || "[data-task-prompt], p",
    checkStatusSelector:
      request.profile?.checkStatusSelector ||
      "[data-check-status], [role='status'], [aria-live], [class*='result'], [class*='status']",
    checkButtonText: request.profile?.checkButtonText || "Run Check",
    submitButtonText: request.profile?.submitButtonText || "Finish & Submit",
    expandButtonText: request.profile?.expandButtonText || "Expand",
    startButtonText: request.profile?.startButtonText || "Skip and Start",
    levelStartPattern:
      request.profile?.levelStartPattern || "^(?:Skip and Start|L\\d+\\s+.+\\s+\\d+s)$",
    passPattern: request.profile?.passPattern || "passed|correct|success|all tests pass",
    failPattern: request.profile?.failPattern || "failed|incorrect|error|test failure",
    pendingPattern: request.profile?.pendingPattern || "checking|running|pending",
  };

  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const buttonsMatching = (text) => [...document.querySelectorAll("button")]
    .filter((button) => visible(button) && normalize(button.textContent).toLowerCase() === text.toLowerCase());
  const startButtons = () => {
    const pattern = new RegExp(profile.levelStartPattern, "i");
    return [...document.querySelectorAll("button")]
      .filter((button) => visible(button) && pattern.test(normalize(button.textContent)));
  };

  function findCardForButton(button) {
    const explicit = button.closest(profile.cardSelector);
    if (explicit) return explicit;
    let candidate = button.parentElement;
    while (candidate && candidate !== document.body) {
      const editors = candidate.querySelectorAll(profile.editorSelector);
      const checks = [...candidate.querySelectorAll("button")].filter(
        (item) => normalize(item.textContent).toLowerCase() === profile.checkButtonText.toLowerCase(),
      );
      if (editors.length >= 1 && checks.length === 1) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  function cardElements() {
    const seen = new Set();
    return buttonsMatching(profile.checkButtonText)
      .map(findCardForButton)
      .filter((card) => {
        if (!card || seen.has(card)) return false;
        seen.add(card);
        return true;
      });
  }

  function editorFor(card) {
    return card.querySelector(profile.editorSelector);
  }

  function editorKind(editor) {
    if (!editor) return "missing";
    if (editor.matches("textarea")) return "textarea";
    if (editor.matches("input")) return "input";
    if (editor.matches(".CodeMirror")) return "codemirror5";
    if (editor.matches(".cm-editor") || editor.closest(".cm-editor")) return "codemirror6";
    if (editor.matches(".monaco-editor") || editor.closest(".monaco-editor")) return "monaco";
    if (editor.isContentEditable || editor.matches("[contenteditable='true']")) return "contenteditable";
    return "unknown";
  }

  function matchingEditorOrdinal(editor, selector) {
    return [...document.querySelectorAll(selector)].indexOf(editor.closest(selector) || editor);
  }

  function readEditor(editor) {
    const kind = editorKind(editor);
    if (kind === "textarea" || kind === "input") return editor.value;
    if (kind === "codemirror5" && editor.CodeMirror?.getValue) return editor.CodeMirror.getValue();
    if (kind === "monaco" && globalThis.monaco?.editor?.getModels) {
      const ordinal = matchingEditorOrdinal(editor, ".monaco-editor");
      const model = globalThis.monaco.editor.getModels()[ordinal];
      if (model) return model.getValue();
    }
    const content = editor.matches(".cm-editor")
      ? editor.querySelector(".cm-content")
      : editor;
    if (content?.isContentEditable) return content.innerText || content.textContent || "";
    const lines = editor.querySelectorAll?.(".view-line");
    if (lines?.length) return [...lines].map((line) => line.textContent).join("\n");
    return editor.textContent || "";
  }

  function dispatchEdit(element, value) {
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setEditor(editor, value) {
    const kind = editorKind(editor);
    if (kind === "textarea") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter.call(editor, value);
      dispatchEdit(editor, value);
      return;
    }
    if (kind === "input") {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter.call(editor, value);
      dispatchEdit(editor, value);
      return;
    }
    if (kind === "codemirror5" && editor.CodeMirror?.setValue) {
      editor.CodeMirror.setValue(value);
      return;
    }
    if (kind === "monaco" && globalThis.monaco?.editor?.getModels) {
      const ordinal = matchingEditorOrdinal(editor, ".monaco-editor");
      const model = globalThis.monaco.editor.getModels()[ordinal];
      if (!model) throw new Error(`No Monaco model for editor ${ordinal}`);
      model.setValue(value);
      return;
    }
    const content = editor.matches(".cm-editor")
      ? editor.querySelector(".cm-content")
      : editor;
    if (content?.isContentEditable) {
      content.focus();
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(content);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, value)) {
        content.textContent = value;
        dispatchEdit(content, value);
      }
      return;
    }
    throw new Error(`Unsupported editor kind: ${kind}`);
  }

  function titleFor(card, index) {
    const explicit = card.querySelector(profile.titleSelector);
    const firstLine = String(card.innerText || "")
      .split("\n")
      .map(normalize)
      .find(Boolean);
    return normalize(explicit?.textContent || firstLine || `Problem ${index + 1}`);
  }

  function idFor(card, index, title) {
    if (card.dataset.taskId) return card.dataset.taskId;
    const bracketed = title.match(/\[(\d+)]/);
    if (bracketed) return `problem-${bracketed[1].padStart(2, "0")}`;
    return `problem-${String(index + 1).padStart(2, "0")}`;
  }

  function promptFor(card) {
    const explicit = [...card.querySelectorAll("[data-task-prompt]")]
      .map((element) => normalize(element.textContent))
      .filter(Boolean);
    if (explicit.length > 0) return [...new Set(explicit)].join("\n");
    const prompts = [...card.querySelectorAll(profile.promptSelector)]
      .filter((element) => !element.closest("button, textarea, [data-check-status], [role='status'], [aria-live]"))
      .map((element) => normalize(element.textContent))
      .filter(Boolean);
    const uniquePrompts = [...new Set(prompts)];
    if (uniquePrompts.length > 0) return uniquePrompts.join("\n");
    return normalize([...card.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(" "));
  }

  async function expandCards() {
    const expandButtons = cardElements()
      .flatMap((card) => [...card.querySelectorAll("button")])
      .filter((button) => (
        visible(button)
        && !button.disabled
        && normalize(button.textContent).toLowerCase() === profile.expandButtonText.toLowerCase()
      ));
    for (const button of expandButtons) button.click();
    if (expandButtons.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, request.expandWaitMs || 50));
    }
    return expandButtons.length;
  }

  function statusFor(card) {
    const element = card.querySelector(profile.checkStatusSelector);
    const raw = normalize([
      element?.dataset?.status,
      element?.getAttribute?.("data-state"),
      element?.textContent,
    ].filter(Boolean).join(" "));
    if (!raw) return { state: "unknown", text: "" };
    if (new RegExp(profile.pendingPattern, "i").test(raw)) return { state: "pending", text: raw };
    if (new RegExp(profile.failPattern, "i").test(raw)) return { state: "failed", text: raw };
    if (new RegExp(profile.passPattern, "i").test(raw)) return { state: "passed", text: raw };
    return { state: "unknown", text: raw };
  }

  function describeCards() {
    return cardElements().map((card, index) => {
      const title = titleFor(card, index);
      const editor = editorFor(card);
      return {
        card,
        editor,
        id: idFor(card, index, title),
        index,
        title,
      };
    });
  }

  const expandedCount = request.operation === "capture" ? await expandCards() : 0;
  const cards = describeCards();
  if (request.operation === "startLevel") {
    if (cards.length > 0) return { clicked: false, cardCount: cards.length };
    const buttons = startButtons();
    if (buttons.length !== 1) {
      throw new Error(`Expected one visible level-start button, found ${buttons.length}`);
    }
    const text = normalize(buttons[0].textContent);
    buttons[0].click();
    return { clicked: true, text, cardCount: 0 };
  }
  if (request.operation !== "inspect" && cards.length === 0) {
    const starts = startButtons();
    if (starts.length === 1) {
      throw new Error("Challenge level has not started; use the visible Skip and Start control first");
    }
    throw new Error("No challenge cards with visible Run Check buttons were found");
  }

  if (request.operation === "inspect") {
    return {
      url: location.href,
      title: document.title,
      cardCount: cards.length,
      submitButtonCount: buttonsMatching(profile.submitButtonText).length,
      startButtonCount: startButtons().length,
      cards: cards.map(({ card, editor, id, index, title }) => ({
        id,
        index,
        title,
        editorKind: editorKind(editor),
        promptLength: promptFor(card).length,
        starterLength: editor ? readEditor(editor).length : 0,
        check: statusFor(card),
      })),
    };
  }

  if (request.operation === "capture") {
    return {
      schemaVersion: 1,
      run: {
        id: request.runId || `browser-${Date.now()}`,
        deadlineMs: request.deadlineMs || 60_000,
      },
      page: { url: location.href, title: document.title },
      capture: { expandedCount },
      tasks: cards.map(({ card, editor, id, index, title }) => {
        if (!editor) throw new Error(`No editor found for ${id}`);
        const starterCode = readEditor(editor);
        const functionName = starterCode.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1];
        if (!functionName) throw new Error(`Could not identify the function name for ${id}`);
        return {
          id,
          kind: "javascript",
          pageIndex: index,
          title,
          prompt: promptFor(card),
          functionName,
          starterCode,
          tests: [],
        };
      }),
    };
  }

  const requested = new Map((request.solutions || []).map((solution) => [solution.id, solution.code]));

  if (request.operation === "fill") {
    return cards
      .filter(({ id }) => requested.has(id))
      .map(({ editor, id }) => {
        if (!editor) throw new Error(`No editor found for ${id}`);
        const expected = requested.get(id);
        setEditor(editor, expected);
        const actual = readEditor(editor);
        return { id, editorKind: editorKind(editor), matches: actual === expected, actual };
      });
  }

  if (request.operation === "verify") {
    return cards
      .filter(({ id }) => requested.has(id))
      .map(({ editor, id }) => ({
        id,
        actual: editor ? readEditor(editor) : null,
        matches: editor ? readEditor(editor) === requested.get(id) : false,
      }));
  }

  if (request.operation === "readEditors") {
    return cards.map(({ editor, id }) => ({
      id,
      actual: editor ? readEditor(editor) : null,
      editorKind: editorKind(editor),
    }));
  }

  if (request.operation === "clickChecks") {
    const ids = new Set(request.ids || cards.map(({ id }) => id));
    return cards
      .filter(({ id }) => ids.has(id))
      .map(({ card, id }) => {
        const button = [...card.querySelectorAll("button")].find(
          (item) => normalize(item.textContent).toLowerCase() === profile.checkButtonText.toLowerCase(),
        );
        if (!button) throw new Error(`No Run Check button found for ${id}`);
        button.click();
        return id;
      });
  }

  if (request.operation === "readChecks") {
    const ids = new Set(request.ids || cards.map(({ id }) => id));
    return cards
      .filter(({ id }) => ids.has(id))
      .map(({ card, id }) => ({ id, ...statusFor(card) }));
  }

  if (request.operation === "submit") {
    const buttons = buttonsMatching(profile.submitButtonText);
    if (buttons.length !== 1) {
      throw new Error(`Expected one ${profile.submitButtonText} button, found ${buttons.length}`);
    }
    buttons[0].click();
    return { clicked: true, text: normalize(buttons[0].textContent) };
  }

  throw new Error(`Unknown browser bridge operation: ${request.operation}`);
}
