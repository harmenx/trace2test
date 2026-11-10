export class Trace2TestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Trace2TestError";
  }
}
