/**
 * Minimal, strictly-typed subset of the official Obsidian API declarations
 * (MIT, © Obsidian.md — https://github.com/obsidianmd/obsidian-api), covering
 * exactly the surface this plugin uses.
 *
 * Why vendored: the community directory's automated review lints the repo
 * WITHOUT installing dependencies. Unresolved imports become the `error`
 * type, which floods the report with no-unsafe-* warnings; the official
 * obsidian.d.ts can't be vendored verbatim because its `any`s trip the same
 * review. So this file re-declares the used surface with `unknown`-tight
 * types.
 *
 * Drift guard: `npm run build` ALSO typechecks against the real `obsidian`
 * package (tsconfig.real.json, no path override), so a signature here that
 * disagrees with the official API fails the build.
 */

declare global {
  interface DomElementInfo {
    /** The class to be assigned. Space-separated string or array of strings. */
    cls?: string | string[];
    /** The textContent to be assigned. */
    text?: string | DocumentFragment;
    /** HTML attributes to be added. */
    attr?: {
      [key: string]: string | number | boolean | null;
    };
    /** HTML title (for hover tooltip). */
    title?: string;
    /** The parent element to be assigned to. */
    parent?: Node;
    value?: string;
    type?: string;
    prepend?: boolean;
    placeholder?: string;
    href?: string;
  }
  interface Node {
    /** Create an element and append it to this node. */
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      callback?: (el: HTMLElementTagNameMap[K]) => void,
    ): HTMLElementTagNameMap[K];
    createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(
      o?: DomElementInfo | string,
      callback?: (el: HTMLSpanElement) => void,
    ): HTMLSpanElement;
    /** Appends a text node to this node. */
    appendText(val: string): void;
    /** Removes all child nodes. */
    empty(): void;
    /** Removes this node from its parent. */
    detach(): void;
    setText(val: string | DocumentFragment): void;
  }
  interface Element {
    addClass(...classes: string[]): void;
    addClasses(classes: string[]): void;
    removeClass(...classes: string[]): void;
    removeClasses(classes: string[]): void;
    toggleClass(classes: string | string[], value: boolean): void;
    hasClass(cls: string): boolean;
    setAttr(qualifiedName: string, value: string | number | boolean | null): void;
  }
  interface HTMLElement {
    onClickEvent(
      this: HTMLElement,
      listener: (this: HTMLElement, ev: MouseEvent) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }
}

/** The running Obsidian application. */
export class App {
  vault: Vault;
  workspace: Workspace;
}

export class Vault {
  adapter: DataAdapter;
  /** Get all Markdown files in the vault. */
  getMarkdownFiles(): TFile[];
  /** Get a file or folder inside the vault by path. */
  getAbstractFileByPath(path: string): TAbstractFile | null;
  /** Read the content of a plaintext file stored in the vault. */
  read(file: TFile): Promise<string>;
  /** Read a plaintext file that is stored inside the vault (possibly from cache). */
  cachedRead(file: TFile): Promise<string>;
  /** Modify the contents of a plaintext file in the vault. */
  modify(file: TFile, data: string): Promise<void>;
  /** Create a new plaintext file inside the vault. */
  create(path: string, data: string): Promise<TFile>;
}

export interface DataAdapter {
  exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
  read(normalizedPath: string): Promise<string>;
  write(normalizedPath: string, data: string): Promise<void>;
  stat(normalizedPath: string): Promise<Stat | null>;
  remove(normalizedPath: string): Promise<void>;
}

export interface Stat {
  type: 'file' | 'folder';
  /** Time of creation, represented as a unix timestamp, in milliseconds. */
  ctime: number;
  /** Time of last modification, represented as a unix timestamp, in milliseconds. */
  mtime: number;
  /** Size on disk, as bytes. */
  size: number;
}

export abstract class TAbstractFile {
  path: string;
  name: string;
  vault: Vault;
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: FileStats;
}

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export class Workspace {
  /** Runs the callback (and defers any initial layout changes) until layout is ready. */
  onLayoutReady(callback: () => unknown): void;
  getLeavesOfType(viewType: string): WorkspaceLeaf[];
  getRightLeaf(shouldSplit: boolean): WorkspaceLeaf | null;
  getLeaf(newLeaf?: boolean): WorkspaceLeaf;
  revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
  /** Returns the file for the current view if it's a FileView. */
  getActiveFile(): TFile | null;
  openLinkText(
    linktext: string,
    sourcePath: string,
    newLeaf?: boolean,
    openViewState?: Record<string, unknown>,
  ): Promise<void>;
}

export class WorkspaceLeaf {
  view: View;
  setViewState(viewState: ViewState, eState?: unknown): Promise<void>;
}

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
  pinned?: boolean;
  group?: WorkspaceLeaf;
}

export abstract class Component {
  load(): void;
  onload(): Promise<void> | void;
  unload(): void;
  onunload(): void;
  /** Registers an interval (from setInterval) to be cancelled when unloading. */
  registerInterval(id: number): number;
}

export abstract class View extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  protected constructor(leaf: WorkspaceLeaf);
  abstract getViewType(): string;
  abstract getDisplayText(): string;
  getIcon(): IconName;
  onOpen(): Promise<void>;
  onClose(): Promise<void>;
}

export abstract class ItemView extends View {
  contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf);
}

export type IconName = string;

/** Insert an SVG into the element from an icon name. */
export function setIcon(parent: HTMLElement, iconId: IconName): void;

export interface PluginManifest {
  id: string;
  name: string;
  author: string;
  version: string;
  minAppVersion: string;
  description: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
}

export interface Command {
  id: string;
  name: string;
  icon?: IconName;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

export abstract class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  constructor(app: App, manifest: PluginManifest);
  onload(): Promise<void> | void;
  addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
  addStatusBarItem(): HTMLElement;
  addCommand(command: Command): Command;
  addSettingTab(settingTab: PluginSettingTab): void;
  registerView(type: string, viewCreator: (leaf: WorkspaceLeaf) => View): void;
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class Notice {
  constructor(message: string | DocumentFragment, duration?: number);
  setMessage(message: string | DocumentFragment): this;
  hide(): void;
}

export class Modal {
  app: App;
  scope: Scope;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(app: App);
  open(): void;
  close(): void;
  onOpen(): Promise<void> | void;
  onClose(): void;
  setTitle(title: string): this;
}

export class Scope {}

export abstract class BaseComponent {
  disabled: boolean;
  setDisabled(disabled: boolean): this;
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement);
  setCta(): this;
  setDestructive(): this;
  setButtonText(name: string): this;
  setIcon(icon: IconName): this;
  setTooltip(tooltip: string): this;
  onClick(callback: (evt: MouseEvent) => unknown): this;
}

export abstract class TextComponent extends BaseComponent {
  inputEl: HTMLInputElement;
  getValue(): string;
  setValue(value: string): this;
  setPlaceholder(placeholder: string): this;
  onChange(callback: (value: string) => unknown): this;
}

export class TextAreaComponent extends BaseComponent {
  inputEl: HTMLTextAreaElement;
  getValue(): string;
  setValue(value: string): this;
  setPlaceholder(placeholder: string): this;
  onChange(callback: (value: string) => unknown): this;
}

export class ToggleComponent extends BaseComponent {
  toggleEl: HTMLElement;
  getValue(): boolean;
  setValue(on: boolean): this;
  onChange(callback: (value: boolean) => unknown): this;
}

export class DropdownComponent extends BaseComponent {
  selectEl: HTMLSelectElement;
  addOption(value: string, display: string): this;
  getValue(): string;
  setValue(value: string): this;
  onChange(callback: (value: string) => unknown): this;
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  constructor(containerEl: HTMLElement);
  setName(name: string | DocumentFragment): this;
  setDesc(desc: string | DocumentFragment): this;
  setClass(cls: string): this;
  setHeading(): this;
  setDisabled(disabled: boolean): this;
  addButton(cb: (component: ButtonComponent) => unknown): this;
  addToggle(cb: (component: ToggleComponent) => unknown): this;
  addText(cb: (component: TextComponent) => unknown): this;
  addTextArea(cb: (component: TextAreaComponent) => unknown): this;
  addDropdown(cb: (component: DropdownComponent) => unknown): this;
}

export abstract class SettingTab {
  app: App;
  containerEl: HTMLElement;
  /** Re-renders the tab from getSettingDefinitions(). @since 1.13.0 */
  update(): void;
  /** @deprecated Since 1.13.0. Use getSettingDefinitions instead. */
  display(): void;
  hide(): void;
}

export abstract class PluginSettingTab extends SettingTab {
  constructor(app: App, plugin: Plugin);
  /** @since 1.13.0 */
  getSettingDefinitions(): SettingDefinitionItem[];
  /** @since 1.13.0 */
  getControlValue(key: string): unknown;
  /** @since 1.13.0 */
  setControlValue(key: string, value: unknown): void | Promise<void>;
}

/** @since 1.13.0 */
export interface SettingGroup {
  containerEl: HTMLElement;
}

/** @since 1.13.0 */
export interface SettingDefinitionBase {
  /** Display name — used for rendering and search. */
  name: string;
  /** Description text or fragment. */
  desc?: string | DocumentFragment;
  /** Additional search terms. */
  aliases?: string[];
  /** Controls search visibility. Default: true. */
  searchable?: boolean | (() => boolean);
  /** Controls whether the item is rendered. Default: true. */
  visible?: boolean | (() => boolean);
}

/** @since 1.13.0 */
export interface SettingControlBase<V, K extends string = string> {
  /** The config/storage property name passed to get/setControlValue. */
  key: K;
  /** Fallback when the resolver returns undefined/null. */
  defaultValue?: V;
  /** Validate a candidate value before it is persisted. */
  validate?: (value: V) => string | void | Promise<string | void>;
  disabled?: boolean | (() => boolean);
}

/** @since 1.13.0 */
export interface SettingTextControl<K extends string = string>
  extends SettingControlBase<string, K> {
  type: 'text';
  placeholder?: string;
}

/** @since 1.13.0 */
export interface SettingToggleControl<K extends string = string>
  extends SettingControlBase<boolean, K> {
  type: 'toggle';
}

/** @since 1.13.0 */
export interface SettingDropdownControl<K extends string = string>
  extends SettingControlBase<string, K> {
  type: 'dropdown';
  options: Record<string, string>;
}

/** @since 1.13.0 */
export type SettingControl<K extends string = string> =
  | SettingToggleControl<K>
  | SettingDropdownControl<K>
  | SettingTextControl<K>;

/** @since 1.13.0 */
export interface SettingDefinitionControl<K extends string = string> extends SettingDefinitionBase {
  control: SettingControl<K>;
  action?: never;
  render?: never;
}

/** @since 1.13.0 */
export interface SettingDefinitionAction extends SettingDefinitionBase {
  action: (el: HTMLElement, index: number) => void;
  disabled?: boolean | (() => boolean);
  control?: never;
  render?: never;
}

/** @since 1.13.0 */
export interface SettingDefinitionRender extends SettingDefinitionBase {
  control?: never;
  action?: never;
  /** Renders the setting row imperatively. May return a cleanup function. */
  render: (setting: Setting, group: SettingGroup) => void | (() => void);
}

/** @since 1.13.0 */
export interface SettingDefinitionEmpty extends SettingDefinitionBase {
  control?: never;
  action?: never;
  render?: never;
}

/** @since 1.13.0 */
export type SettingDefinition<K extends string = string> =
  | SettingDefinitionControl<K>
  | SettingDefinitionRender
  | SettingDefinitionAction
  | SettingDefinitionEmpty;

/** @since 1.13.0 */
export interface SettingDefinitionGroup<K extends string = string> {
  type: 'group' | 'list';
  heading?: string;
  cls?: string;
  items?: SettingDefinitionItem<K>[];
}

/** @since 1.13.0 */
export type SettingDefinitionItem<K extends string = string> =
  | SettingDefinition<K>
  | SettingDefinitionGroup<K>;

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  /** Whether to throw an error when the status code is 400+. Defaults to true. */
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

/** Similar to fetch(), request a URL using HTTP/HTTPS, without any CORS restrictions. */
export function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse>;
