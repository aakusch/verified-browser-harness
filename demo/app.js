const manifest = await fetch("/fixtures/browser-level1.json").then((response) => response.json());
const challenge = document.querySelector("#challenge");
const state = new URL(location.href).searchParams.get("state") || "ready";

window.__submitCount = 0;
window.__replicaState = state;

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkSolution(task, code) {
  const solution = Function(`"use strict"; return (${code});`)();
  if (typeof solution !== "function") throw new TypeError("Code must evaluate to a function");
  for (const test of task.tests) {
    const actual = solution(...structuredClone(test.args));
    if (!equal(actual, test.expected)) {
      throw new Error(`Expected ${JSON.stringify(test.expected)}, received ${JSON.stringify(actual)}`);
    }
  }
}

// The live challenge gates a level behind a start screen and an entry questionnaire, and
// keeps each card's constraints behind a collapsed toggle. The replica reproduces all
// three so the bridge's detection and expansion paths are exercised locally.
function renderPreStart() {
  challenge.innerHTML = `
    <section class="gate">
      <h2>Level 1 is ready</h2>
      <p>Press start when you are ready. The timer begins immediately.</p>
      <button id="start" type="button">Start Challenge</button>
    </section>
  `;
  document.querySelector("#start").addEventListener("click", () => {
    location.search = "";
  });
}

function renderQuestionnaire() {
  challenge.innerHTML = `
    <section class="gate">
      <h2>Before you begin</h2>
      <form id="entry">
        <fieldset>
          <legend>How many years have you written JavaScript?</legend>
          <label><input type="radio" name="experience" value="0-2" /> 0-2</label>
          <label><input type="radio" name="experience" value="3-5" /> 3-5</label>
          <label><input type="radio" name="experience" value="6+" /> 6 or more</label>
        </fieldset>
        <label>Referral
          <select name="referral">
            <option value="">Choose one</option>
            <option value="friend">A friend</option>
            <option value="search">Search</option>
          </select>
        </label>
        <button type="submit">Continue</button>
      </form>
    </section>
  `;
  document.querySelector("#entry").addEventListener("submit", (event) => {
    event.preventDefault();
    location.search = "";
  });
}

function renderCards() {
  for (const task of manifest.tasks) {
    const card = document.createElement("article");
    card.className = "task-card";
    card.innerHTML = `
      <div class="task-heading">
        <h2 data-task-title>${task.title}</h2>
        <span class="difficulty">easy</span>
      </div>
      <div data-task-prompt>
        <p>${task.prompt}</p>
        <details>
          <summary>Show details</summary>
          <p>Hidden constraint for ${task.id}: return a plain value and do not mutate the arguments.</p>
        </details>
      </div>
      <textarea data-code-editor spellcheck="false" aria-label="${task.title} code"></textarea>
      <div class="check-row">
        <span data-check-status data-status="idle" role="status">Not checked</span>
        <button data-run-check type="button">Run Check</button>
      </div>
    `;
    const editor = card.querySelector("textarea");
    const status = card.querySelector("[data-check-status]");
    const button = card.querySelector("[data-run-check]");
    editor.value = task.starterCode;
    button.addEventListener("click", () => {
      status.dataset.status = "pending";
      status.textContent = "Checking";
      setTimeout(() => {
        try {
          checkSolution(task, editor.value);
          status.dataset.status = "passed";
          status.textContent = "All tests passed";
          card.dataset.checkState = "passed";
        } catch (error) {
          status.dataset.status = "failed";
          status.textContent = `Failed: ${error.message}`;
          card.dataset.checkState = "failed";
        }
      }, 35);
    });
    challenge.append(card);
  }
}

if (state === "prestart") renderPreStart();
else if (state === "questionnaire") renderQuestionnaire();
else renderCards();

document.querySelector("#finish").addEventListener("click", () => {
  window.__submitCount += 1;
  const cards = [...document.querySelectorAll(".task-card")];
  const passed = cards.length > 0 && cards.every((card) => card.dataset.checkState === "passed");
  const status = document.querySelector("#final-status");
  status.textContent = passed ? "Submitted" : "Submission rejected";
  status.dataset.status = passed ? "passed" : "failed";
});
