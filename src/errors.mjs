export class HarnessError extends Error {
  constructor(message, { code = "HARNESS_ERROR", cause, details } = {}) {
    super(message, { cause });
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}

export function asHarnessError(error, fallbackCode = "HARNESS_ERROR") {
  if (error instanceof HarnessError) return error;
  return new HarnessError(error instanceof Error ? error.message : String(error), {
    code: fallbackCode,
    cause: error instanceof Error ? error : undefined,
  });
}
