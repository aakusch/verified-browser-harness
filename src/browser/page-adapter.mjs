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
    promptSelector: request.profile?.promptSelector || "[data-task-prompt]",
    checkStatusSelector:
      request.profile?.checkStatusSelector ||
      "[data-check-status], [role='status'], [aria-live], [class*='result'], [class*='status']",
    // Text nodes inside these are page furniture, never part of the visible prompt.
    promptExcludeSelector:
      request.profile?.promptExcludeSelector ||
      "button, [role='button'], summary, select, option, [data-check-status], [class*='difficulty'], [class*='badge'], [class*='timer']",
    checkButtonText: request.profile?.checkButtonText || "Run Check",
    submitButtonText: request.profile?.submitButtonText || "Finish & Submit",
    expandTogglePattern:
      request.profile?.expandTogglePattern ||
      "show more|show details|view details|see details|read more|expand|details",
    startButtonPattern:
      request.profile?.startButtonPattern ||
      "^(start|begin|start challenge|start level|enter challenge|let'?s go)$",
    questionnaireSelector:
      request.profile?.questionnaireSelector ||
      "[data-questionnaire], form input[type='radio'], form input[type='checkbox'], form select",
    passPattern: request.profile?.passPattern || "passed|correct|success|all tests pass",
    failPattern: request.profile?.failPattern || "failed|incorrect|error|test failure",
    pendingPattern: request.profile?.pendingPattern || "checking|running|pending",
  };

  const fail = (code, message, details) => ({ __harnessError: { code, message, details } });
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

  function visible(element) {
    if (!(element instanceof Element)) return false;
    // A closed <details> hides everything except its own summary, and browsers do not
    // report that through the child's own computed style.
    const collapsed = element.closest("details:not([open])");
    if (collapsed && !element.closest("summary")) return false;
    if (typeof element.checkVisibility === "function") {
      return element.checkVisibility({ checkVisibilityCSS: true });
    }
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  const allButtons = () => [
    ...document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"),
  ];
  const buttonLabel = (button) => normalize(button.textContent || button.value);

  function buttonsMatching(text) {
    const wanted = text.toLowerCase();
    const candidates = allButtons().filter(visible);
    const exact = candidates.filter((button) => buttonLabel(button).toLowerCase() === wanted);
    if (exact.length > 0) return exact;
    // Live pages decorate labels ("▶ Run Check"); fall back to containment, never to a
    // looser match than that.
    return candidates.filter((button) => buttonLabel(button).toLowerCase().includes(wanted));
  }

  const isCheckButton = (element) =>
    buttonLabel(element).toLowerCase().includes(profile.checkButtonText.toLowerCase());

  function findCardForButton(button) {
    const explicit = button.closest(profile.cardSelector);
    if (explicit) return explicit;
    let candidate = button.parentElement;
    while (candidate && candidate !== document.body) {
      const editors = candidate.querySelectorAll(profile.editorSelector);
      const checks = [...candidate.querySelectorAll("button")].filter(isCheckButton);
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

  function titleElementFor(card) {
    return card.querySelector(profile.titleSelector);
  }

  function titleFor(card, index) {
    const explicit = titleElementFor(card);
    if (explicit) return normalize(explicit.textContent);
    const firstLine = String(card.innerText || "")
      .split("\n")
      .map(normalize)
      .find(Boolean);
    return normalize(firstLine || `Problem ${index + 1}`);
  }

  function idFor(card, index, title) {
    if (card.dataset.taskId) return card.dataset.taskId;
    const bracketed = title.match(/\[(\d+)]/);
    if (bracketed) return `problem-${bracketed[1].padStart(2, "0")}`;
    return `problem-${String(index + 1).padStart(2, "0")}`;
  }

  function collapsedRegions(card) {
    const details = [...card.querySelectorAll("details:not([open])")];
    const pattern = new RegExp(profile.expandTogglePattern, "i");
    const toggles = allButtons().filter((button) =>
      card.contains(button) &&
      visible(button) &&
      button.getAttribute("aria-expanded") === "false" &&
      pattern.test(buttonLabel(button)));
    return details.length + toggles.length;
  }

  /**
   * Opens every collapsed region inside one card.
   *
   * Why: the challenge cards keep constraints, edge cases, and examples behind a
   * "show details" toggle. Capturing before expanding sends the model a prompt that is
   * missing exactly the parts that decide the answer.
   */
  function expandCard(card) {
    let expanded = 0;
    for (const details of card.querySelectorAll("details")) {
      if (!details.open) {
        details.open = true;
        expanded += 1;
      }
    }
    const pattern = new RegExp(profile.expandTogglePattern, "i");
    for (const button of allButtons()) {
      if (!card.contains(button) || !visible(button)) continue;
      if (button.getAttribute("aria-expanded") !== "false") continue;
      const label = buttonLabel(button);
      if (isCheckButton(button)) continue;
      if (label.toLowerCase() === profile.submitButtonText.toLowerCase()) continue;
      if (!pattern.test(label)) continue;
      button.click();
      expanded += 1;
    }
    return expanded;
  }

  /**
   * Collects the card's visible prompt exactly once.
   *
   * Why: unioning `[data-task-prompt], p` returns both a wrapper and the paragraphs inside
   * it, so the prompt reached the model duplicated. Walking visible text nodes instead
   * yields each rendered string once, in reading order, with the title, editor, status,
   * and controls removed.
   */
  function promptFor(card, editor) {
    const marked = [...card.querySelectorAll(profile.promptSelector)].filter(visible);
    const roots = marked.length > 0
      ? marked.filter((element) => !marked.some((other) => other !== element && other.contains(element)))
      : [card];
    const titleElement = titleElementFor(card);
    const excluded = (element) => {
      if (editor && (element === editor || editor.contains(element) || element.contains(editor))) {
        return true;
      }
      if (titleElement && (element === titleElement || titleElement.contains(element))) return true;
      return element.matches(profile.promptExcludeSelector);
    };

    const lines = [];
    let currentParent = null;
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = normalize(node.nodeValue);
        if (text) {
          let element = node.parentElement;
          let skip = false;
          while (element && root.parentElement !== element && element !== document.body) {
            if (excluded(element) || !visible(element)) {
              skip = true;
              break;
            }
            if (element === root) break;
            element = element.parentElement;
          }
          if (!skip) {
            if (node.parentElement === currentParent && lines.length > 0) {
              lines[lines.length - 1] = `${lines[lines.length - 1]} ${text}`;
            } else {
              lines.push(text);
              currentParent = node.parentElement;
            }
          }
        }
        node = walker.nextNode();
      }
    }

    const seen = new Set();
    return lines
      .filter((line) => {
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      })
      .join("\n");
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

  /**
   * Names the page state when no solvable card is present, so the operator gets
   * "the level has not started" instead of a generic selector failure.
   */
  function describePageState(cardCount) {
    if (cardCount > 0) return { state: "ready", evidence: {} };
    const startPattern = new RegExp(profile.startButtonPattern, "i");
    const startButtons = allButtons()
      .filter((button) => visible(button) && startPattern.test(buttonLabel(button)))
      .map(buttonLabel);
    const questionnaireFields = [...document.querySelectorAll(profile.questionnaireSelector)]
      .filter(visible);
    if (questionnaireFields.length > 0) {
      return {
        state: "questionnaire",
        evidence: { questionnaireFields: questionnaireFields.length, startButtons },
      };
    }
    if (startButtons.length > 0) {
      return { state: "not-started", evidence: { startButtons } };
    }
    return { state: "unknown", evidence: { buttons: allButtons().filter(visible).map(buttonLabel).slice(0, 10) } };
  }

  const PAGE_STATE_ERRORS = {
    questionnaire: [
      "QUESTIONNAIRE_PRESENT",
      "The page is showing a questionnaire or entry form, not challenge cards. Answer it yourself, then re-run.",
    ],
    "not-started": [
      "PAGE_NOT_STARTED",
      "The level has not started yet. Press the visible start control yourself, then re-run.",
    ],
    unknown: [
      "NO_TASK_CARDS",
      "No challenge cards with visible Run Check buttons were found",
    ],
  };

  let cards = describeCards();
  const pageState = describePageState(cards.length);
  if (request.operation !== "inspect" && cards.length === 0) {
    const [code, message] = PAGE_STATE_ERRORS[pageState.state] || PAGE_STATE_ERRORS.unknown;
    return fail(code, message, { pageState: pageState.state, ...pageState.evidence });
  }

  if (request.operation === "inspect") {
    return {
      url: location.href,
      title: document.title,
      pageState: pageState.state,
      pageStateEvidence: pageState.evidence,
      cardCount: cards.length,
      submitButtonCount: buttonsMatching(profile.submitButtonText).length,
      cards: cards.map(({ card, editor, id, index, title }) => {
        const prompt = promptFor(card, editor);
        return {
          id,
          index,
          title,
          editorKind: editorKind(editor),
          promptLength: prompt.length,
          // Opt-in because inspect is the cheap pre-run check. Still read-only: this is
          // the prompt as currently rendered, with nothing expanded.
          ...(request.includePrompts
            ? { prompt, starterCode: editor ? readEditor(editor) : null }
            : {}),
          // inspect never mutates the page, so report what capture would expand instead.
          collapsedRegions: collapsedRegions(card),
          starterLength: editor ? readEditor(editor).length : 0,
          check: statusFor(card),
        };
      }),
    };
  }

  if (request.operation === "expand") {
    return cards.map(({ card, id }) => ({ id, expanded: expandCard(card) }));
  }

  if (request.operation === "capture") {
    const expansions = cards.map(({ card }) => expandCard(card));
    // Expanding can reveal further nested regions; re-read the cards once afterwards.
    cards = describeCards();
    const tasks = [];
    const skipped = [];
    cards.forEach(({ card, editor, id, index, title }) => {
      if (!editor) {
        skipped.push({ id, index, reason: "No editor found in the card" });
        return;
      }
      const starterCode = readEditor(editor);
      const functionName = starterCode.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1];
      if (!functionName) {
        skipped.push({ id, index, reason: "Could not identify the function name in the starter code" });
        return;
      }
      tasks.push({
        id,
        kind: "javascript",
        pageIndex: index,
        title,
        prompt: promptFor(card, editor),
        functionName,
        starterCode,
        tests: [],
      });
    });
    if (tasks.length === 0) {
      return fail("NO_CAPTURABLE_CARDS", "No visible card produced a usable JavaScript task", {
        cardCount: cards.length,
        skipped,
      });
    }
    return {
      schemaVersion: 1,
      run: {
        id: request.runId || `browser-${Date.now()}`,
        deadlineMs: request.deadlineMs || 60_000,
      },
      page: { url: location.href, title: document.title },
      capture: {
        cardCount: cards.length,
        expandedRegions: expansions.reduce((total, count) => total + count, 0),
        remainingCollapsedRegions: cards.reduce(
          (total, { card }) => total + collapsedRegions(card),
          0,
        ),
        skipped,
      },
      tasks,
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
        const button = [...card.querySelectorAll("button")].find(isCheckButton);
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
    const notPassing = cards
      .map(({ card, id }) => ({ id, ...statusFor(card) }))
      .filter((status) => status.state !== "passed");
    if (notPassing.length > 0) {
      // Last line of defence: the page itself refuses to click submit while any visible
      // check is not green, even if a caller reached this operation directly.
      return fail(
        "VISIBLE_CHECK_NOT_PASSING",
        `${notPassing.length} visible check(s) are not passing`,
        { statuses: notPassing },
      );
    }
    const buttons = buttonsMatching(profile.submitButtonText);
    if (buttons.length !== 1) {
      return fail(
        "SUBMIT_BUTTON_AMBIGUOUS",
        `Expected one ${profile.submitButtonText} button, found ${buttons.length}`,
        { found: buttons.length },
      );
    }
    buttons[0].click();
    return { clicked: true, text: buttonLabel(buttons[0]) };
  }

  return fail("UNKNOWN_BRIDGE_OPERATION", `Unknown browser bridge operation: ${request.operation}`);
}
