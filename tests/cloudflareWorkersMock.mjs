export class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const cache = {
  purge: async () => ({ success: true, errors: [] }),
};
