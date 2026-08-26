const manifest = await fetch("/fixtures/browser-level1.json").then((response) => response.json());
const challenge = document.querySelector("#challenge");

window.__submitCount = 0;

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

function startLevel() {
  document.querySelector("#pre-start")?.remove();
  for (const task of manifest.tasks) {
  const detailLabel = ["Expand", "Show details", "View details", "Read more"][
    Number.parseInt(task.id.match(/(\d+)$/)?.[1] || "0", 10) % 4
  ];
  const card = document.createElement("article");
  card.className = "task-card";
  card.innerHTML = `
    <div class="task-heading">
      <h2 data-task-title>${task.title}</h2>
      <span class="difficulty">easy</span>
    </div>
    <p class="prompt-preview">Open the task details to view the full specification.</p>
    <button class="expand-task" type="button">${detailLabel}</button>
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
  card.querySelector(".expand-task").addEventListener("click", (event) => {
    event.currentTarget.remove();
    const prompt = document.createElement("p");
    prompt.dataset.taskPrompt = "";
    prompt.textContent = task.prompt;
    card.querySelector(".task-heading").after(prompt);
  });
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

document.querySelector("#start-level").addEventListener("click", startLevel);

document.querySelector("#finish").addEventListener("click", () => {
  window.__submitCount += 1;
  const passed = [...document.querySelectorAll(".task-card")]
    .every((card) => card.dataset.checkState === "passed");
  const status = document.querySelector("#final-status");
  status.textContent = passed ? "Submitted" : "Submission rejected";
  status.dataset.status = passed ? "passed" : "failed";
});
