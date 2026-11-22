/**
 * Minimal ambient declarations, so the TypeScript compiler can check THIS
 * codebase without node_modules present.
 *
 * ONLY for tsconfig.check.json (the offline check). It lived in types/, which
 * the real tsconfig.json includes, so on a machine WITH node_modules these
 * loose declarations replaced React's and Next's own and the real type check
 * and `next build` failed (first CI run, Nov 2026).
 *
 * WHY THIS EXISTS
 *
 * Every check in tools/ is a regex approximating a compiler. That has been the
 * root cause of most of the bugs that reached the user: an undefined variable,
 * a property that does not exist on a record, a function called with the wrong
 * number of arguments. A compiler finds all three in a second and I have been
 * finding them one at a time, in production, via screenshots.
 *
 * The real dependencies cannot be installed here -- the registry is not
 * reachable. So React and Next are declared loosely enough that JSX resolves,
 * and precisely enough that OUR OWN types are still enforced:
 *
 *   * an identifier that does not exist is still an error
 *   * a property missing from one of our interfaces is still an error
 *   * a wrong argument count on one of our functions is still an error
 *   * null and undefined handling on our own shapes is still enforced
 *
 * What it deliberately does NOT check is React's own API surface -- hook
 * signatures, prop types of library components. Those are approximated. This
 * is a substitute for a compiler on our code, not a substitute for installing
 * the dependencies before shipping.
 *
 * Run: npx tsc -p tsconfig.check.json
 */

declare module "react" {
  export type ReactNode = unknown;
  export type Key = string | number;

  export interface CSSProperties {
    [key: string]: string | number | undefined;
  }

  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export type MutableRefObject<T> = { current: T };

  export function useState<S>(
    initial: S | (() => S),
  ): [S, Dispatch<SetStateAction<S>>];
  export function useState<S = undefined>(): [
    S | undefined,
    Dispatch<SetStateAction<S | undefined>>,
  ];

  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function useMemo<T>(factory: () => T, deps?: unknown[]): T;
  export function useCallback<T>(fn: T, deps?: unknown[]): T;

  export type ComponentType<P = Record<string, unknown>> = (props: P) => unknown;
  export type FC<P = Record<string, unknown>> = (props: P) => unknown;
  export type PropsWithChildren<P = Record<string, unknown>> = P & { children?: ReactNode };
  export type RefObject<T> = { readonly current: T | null };
  export type Provider<T> = (props: { value: T; children?: ReactNode }) => JSX.Element;
  export type Context<T> = { Provider: Provider<T>; Consumer: unknown; _t?: T };

  export function memo<T>(c: T, eq?: unknown): T;
  export function forwardRef<T, P>(r: (props: P, ref: unknown) => unknown): (props: P) => unknown;
  export function createContext<T>(def: T): Context<T>;
  export function useContext<T>(c: Context<T>): T;
  export function useReducer<S, A>(
    r: (s: S, a: A) => S,
    init: S,
  ): [S, (action: A) => void];

  const React: unknown;
  export default React;
}

declare module "next/navigation" {
  export function useParams<T = Record<string, string>>(): T;
  export function useRouter(): {
    push(href: string): void;
    replace(href: string): void;
    back(): void;
    refresh(): void;
  };
  export function usePathname(): string;
  export function useSearchParams(): URLSearchParams;
}

declare module "next/font/local" {
  const f: unknown;
  export default f;
}

/**
 * JSX, permissively.
 *
 * Element types and library props are not checked -- that needs the real React
 * types. What IS checked is everything inside the braces: the expressions, the
 * identifiers, and the shapes they come from.
 */
/**
 * DOM element shapes, enough to type an event handler's parameter.
 *
 * noImplicitAny was switched OFF because every `onChange={(e) => ...}` reported
 * an implicit any -- 165 of them, drowning the real errors. Declaring the
 * handful of element types these screens actually touch lets strictness go
 * back on, which is where the value is: an implicit any is a hole the compiler
 * stops looking through.
 */
interface EventTarget {
  value: string;
  checked: boolean;
  name: string;
}
interface HTMLElement extends EventTarget {
  focus(): void;
  blur(): void;
  click(): void;
  select(): void;
  closest(sel: string): HTMLElement | null;
  querySelectorAll<T = HTMLElement>(sel: string): T[];
  style: Record<string, string>;
}
interface HTMLInputElement extends HTMLElement {}
interface HTMLSelectElement extends HTMLElement {}
interface HTMLTextAreaElement extends HTMLElement {}
interface HTMLDivElement extends HTMLElement {}
interface HTMLFormElement extends HTMLElement {}
interface HTMLButtonElement extends HTMLElement {}

interface Window {
  location: { pathname: string; href: string; search: string };
  print(): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  addEventListener(type: string, fn: (e: never) => void): void;
  removeEventListener(type: string, fn: (e: never) => void): void;
}
declare const window: Window;

interface Document {
  querySelectorAll<T = HTMLElement>(sel: string): T[];
  querySelector<T = HTMLElement>(sel: string): T | null;
  addEventListener(type: string, fn: (e: never) => void): void;
  removeEventListener(type: string, fn: (e: never) => void): void;
  body: HTMLElement;
  activeElement: HTMLElement | null;
}
declare const document: Document;

declare namespace JSX {
  interface Element {}
  interface ElementClass {}
  interface ElementAttributesProperty {}
  // Tells TypeScript that nested JSX content satisfies a `children` prop.
  // Without it, every <Wrapper>...</Wrapper> reports children as missing --
  // which is a fault in this shim, not in the code being checked.
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  /**
   * Every tag accepts anything, EXCEPT the handlers -- those are typed, so
   * `onChange={(e) => ...}` infers `e` and noImplicitAny can stay on.
   *
   * Without this the handler is `unknown`, the parameter is an implicit any,
   * and 165 warnings drown the real errors. An implicit any is a hole the
   * compiler stops looking through, which is exactly where the bugs it should
   * have caught live.
   */
  interface DomEvent<T> {
    target: T;
    currentTarget: T;
    preventDefault(): void;
    stopPropagation(): void;
  }
  interface KeyEvent<T> extends DomEvent<T> {
    key: string;
    shiftKey: boolean;
  }

  interface IntrinsicElements {
    [tag: string]: {
      onChange?: (e: DomEvent<HTMLInputElement>) => void;
      onInput?: (e: DomEvent<HTMLInputElement>) => void;
      onClick?: (e: DomEvent<HTMLElement>) => void;
      onKeyDown?: (e: KeyEvent<HTMLInputElement>) => void;
      onKeyUp?: (e: KeyEvent<HTMLInputElement>) => void;
      onSubmit?: (e: DomEvent<HTMLFormElement>) => void;
      onBlur?: (e: DomEvent<HTMLInputElement>) => void;
      onFocus?: (e: DomEvent<HTMLInputElement>) => void;
      [attr: string]: unknown;
    };
  }
}

declare namespace React {
  type ReactNode = unknown;
  type CSSProperties = Record<string, string | number | undefined>;
  type KeyboardEvent<T = unknown> = {
    key: string;
    currentTarget: T;
    target: unknown;
    preventDefault(): void;
    stopPropagation(): void;
  };
  type ChangeEvent<T = unknown> = { target: T; currentTarget: T };
  type MouseEvent<T = unknown> = {
    currentTarget: T;
    preventDefault(): void;
    stopPropagation(): void;
  };
  type FormEvent<T = unknown> = { currentTarget: T; preventDefault(): void };
}

/** Side-effect imports of stylesheets. Next handles these; tsc needs telling. */
declare module "*.css";
declare module "*.svg";

/**
 * Next's own modules. Declared loosely -- the real ones ship with the package
 * and are what a build uses. These exist so an offline type-check can see past
 * them to OUR code, which is the whole point of this file.
 */
declare module "next/image" {
  const Image: (props: Record<string, unknown>) => JSX.Element;
  export default Image;
}
declare module "next/link" {
  const Link: (props: Record<string, unknown>) => JSX.Element;
  export default Link;
}
declare module "next/dynamic" {
  const dynamic: <T>(loader: () => Promise<T>, opts?: unknown) => T;
  export default dynamic;
}
declare module "geist/font/sans" {
  export const GeistSans: { variable: string; className: string };
}
declare module "geist/font/mono" {
  export const GeistMono: { variable: string; className: string };
}
declare module "recharts" {
  // The tooltip props, loosely; the components, as any.
  export type TooltipProps<V = unknown, N = unknown> = {
    active?: boolean;
    payload?: Array<{ payload?: unknown; value?: V; name?: N }>;
    label?: unknown;
  };
  export const Area: any;
  export const AreaChart: any;
  export const Bar: any;
  export const BarChart: any;
  export const CartesianGrid: any;
  export const Cell: any;
  export const ResponsiveContainer: any;
  export const Tooltip: any;
  export const XAxis: any;
  export const YAxis: any;
}
declare module "lucide-react";
