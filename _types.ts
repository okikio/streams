/**
 * `DualDisposable` interface combines the capabilities of both `Disposable` and `AsyncDisposable` interfaces.
 *
 * This interface is used for objects that require explicit resource management, typically for cleaning up
 * resources such as file handles, database connections, or any other resources that need to be disposed
 * of when no longer in use.
 *
 * @example
 * ```typescript
 * class MyResource implements DualDisposable {
 *   [Symbol.dispose]() {
 *     // Synchronous cleanup logic
 *   }
 *
 *   async [Symbol.asyncDispose]() {
 *     // Asynchronous cleanup logic
 *   }
 * }
 *
 * const resource = new MyResource();
 *
 * // Ensure resource is disposed synchronously
 * using (resource) {
 *   // Work with resource
 * }
 *
 * // Ensure resource is disposed asynchronously
 * await using (await resource) {
 *   // Work with resource asynchronously
 * }
 * ```
 *
 * The `Symbol.dispose` method will be invoked automatically when the scope in which the `using` keyword is used
 * is exited, ensuring that resources are properly released. Similarly, `Symbol.asyncDispose` will be called
 * for asynchronous disposal.
 *
 * @interface
 * @extends Disposable
 * @extends AsyncDisposable
 */
export interface DualDisposable extends Disposable, AsyncDisposable { }


/**
 * A `PromiseWithDisposable` is an extension of the standard `Promise` interface, designed to include
 * the ability to clean up resources once the promise is no longer needed or has completed its operation.
 *
 * ## What is a Disposable?
 *
 * A **disposable** is an object that implements the `Disposable` and/or `AsyncDisposable` interfaces,
 * providing a standard way to release or clean up resources, such as memory or file handles, when they
 * are no longer needed. This is particularly important in scenarios where failing to release resources
 * can lead to memory leaks or other performance issues.
 *
 * The `Disposable` interface typically includes a `dispose` method, which can be called to perform
 * synchronous cleanup. The `AsyncDisposable` interface includes an `asyncDispose` method, which is
 * used for asynchronous cleanup operations.
 *
 * When using a `PromiseWithDisposable`, you can be confident that any associated resources will be
 * properly cleaned up once the promise is settled (resolved or rejected) or when it's manually disposed of.
 * This makes it particularly useful in scenarios where promises represent operations tied to external
 * resources, such as file I/O, network requests, or UI components.
 *
 * @template T - The type of the value that the promise resolves to.
 *
 * @example
 * ```typescript
 * // Create a disposable promise
 * const disposablePromise: PromiseWithDisposable<string> = someAsyncOperation();
 *
 * // Use the promise as you would any other promise
 * disposablePromise.then(result => console.log(result));
 *
 * // When done, dispose of the promise to clean up resources
 * disposablePromise[Symbol.dispose]();
 * ```
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise Promise Documentation}
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose Symbol.dispose Documentation}
 */
export interface PromiseWithDisposal<T> extends Promise<T>, DualDisposable { }