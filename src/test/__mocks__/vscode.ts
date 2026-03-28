export const workspace = {
  getConfiguration: () => ({
    get: (key: string, defaultVal?: any) => defaultVal
  }),
  createFileSystemWatcher: () => ({
    onDidCreate: () => {},
    onDidDelete: () => {},
    dispose: () => {}
  })
};

export const Uri = { joinPath: (...args: any[]) => args.join('/') };

export class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}
