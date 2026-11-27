/** A structured error that is safe to show to an MCP client. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly mutationSent: boolean | "unknown" = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}
