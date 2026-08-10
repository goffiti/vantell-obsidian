/**
 * Minimal ambient stubs for modules referenced by the vendored obsidian.d.ts
 * (types/obsidian.d.ts). They exist so type resolution works without
 * node_modules — e.g. in the community directory's automated review, which
 * lints without installing dependencies. skipLibCheck is on, so these only
 * need to resolve; the plugin itself uses none of these APIs.
 */
declare module 'moment' {
  function moment(...args: unknown[]): moment.Moment;
  namespace moment {
    interface Moment {
      format(format?: string): string;
    }
  }
  export = moment;
}

declare module '@codemirror/state' {
  export type Extension = unknown;
  export interface StateField<T> {
    __value?: T;
  }
}

declare module '@codemirror/view' {
  export interface EditorView {
    readonly dom: unknown;
  }
  export interface ViewPlugin<V> {
    __value?: V;
  }
}
