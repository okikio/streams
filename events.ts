/**
 * This module provides functionality for creating and managing status event dispatchers using the Web Streams API.
 * It allows for efficient broadcasting of status events to multiple listeners with proper handling of backpressure and synchronization.
 *
 * @module
 */

import type { MulticastReadableStream } from "./multicast.ts";
import { createChannel } from "./channel.ts";

/**
 * Creates a status event dispatcher that allows dispatching and listening to status events
 * using the Web Streams API. This function utilizes a channel internally to manage event
 * dispatching and multiple listeners via `for await...of`.
 *
 * ## What is a Channel?
 * A channel is a communication mechanism built on top of Web Streams, allowing data to flow
 * from one or more producers (writers) to multiple independent consumers (readers). Channels
 * efficiently manage data flow, backpressure, and synchronization across multiple consumers.
 *
 * In the context of `createStatusEventDispatcher`, the channel provides the infrastructure for
 * broadcasting status events to multiple listeners while ensuring that all listeners receive
 * the events as they occur. For more details, see the documentation for `createChannel`.
 *
 * ## Key Features:
 * - Allows multiple listeners to concurrently listen to status events using `for await...of`.
 * - Ensures that all listeners receive events, though their processing order may be influenced by backpressure.
 * - Uses `ReadableStream.tee()` to create multiple branches, enabling independent consumption of the same data stream.
 *
 * ## Important Considerations:
 *
 * ### Event Timing and Backpressure
 * - **Event Dispatch Timing**: Unlike `EventTarget`, where all listeners receive the event immediately,
 *   `ReadableStreams` introduce backpressure. This means that if one listener is slower in consuming
 *   the stream, it could delay the delivery of events to other listeners.
 * - **Synchronization**: All branches created via `tee()` must be ready to consume data before the
 *   underlying source produces more data. This can result in a slower processing speed if there is
 *   a discrepancy in consumption rates between different listeners.
 *
 * ### Behavior of `ReadableStream.tee()`
 * - **Mid-Stream `tee()`**: When `tee()` is called on a `ReadableStream` mid-event and a new listener
 *   is added via `for await...of`, the new stream will only start consuming events from the next
 *   unconsumed event onward. It will not receive any previously consumed events from before the `tee()`
 *   was called.
 * - **Pre-existing Streams**: The original stream will continue consuming data as normal, but its
 *   consumption pace might be affected by the newly created branches. Specifically, if the new branches
 *   are slower, the original stream will be paused until all branches are ready to consume the next event.
 * - **No Retroactive Events**: The newly created branches do not loop through or receive events that were
 *   already consumed by the original stream. They only process new events that have not yet been consumed.
 *
 * ### Performance Impact
 * - **Backpressure Management**: The system will introduce natural backpressure if one of the branches
 *   is slower, ensuring data consistency across all branches. However, this could lead to performance
 *   degradation if one listener significantly lags behind others.
 * - **Use Case Suitability**: This method works best when streams are set up at the start and have
 *   similar consumption speeds. If frequent dynamic listener addition is required, a custom event
 *   multiplexing solution might be preferable.
 *
 * @template T - The specific status type being dispatched and listened for.
 *
 * @returns An object with methods to dispatch status events, listen to them, and manage the stream lifecycle.
 *
 * @remarks
 * This function is particularly useful for scenarios where status events need to be broadcasted to multiple
 * listeners that might consume the events at different rates. The use of Web Streams ensures efficient
 * backpressure management, though developers should be aware of the potential impact on performance if
 * listeners consume data at different speeds.
 *
 * @example
 * ```typescript
 * // Create a status event dispatcher
 * const statusDispatcher = createStatusEventDispatcher();
 *
 * // Example listeners using `for await...of`
 * (async () => {
 *   const reader = statusDispatcher.events;
 *   for await (const event of reader) {
 *     console.log("Listener 1 received:", event.status);
 *   }
 * })();
 *
 * (async () => {
 *   const reader = statusDispatcher.events;
 *   for await (const event of reader) {
 *     console.log("Listener 2 received:", event.status);
 *   }
 * })();
 *
 * // Dispatching events
 * (async () => {
 *   const runningEvent = new StatusEvent(Status.Running, { data: { jobId: 123 } });
 *   const pausedEvent = new StatusEvent(Status.Paused);
 *
 *   await statusDispatcher.dispatch(runningEvent);
 *   await statusDispatcher.dispatch(pausedEvent);
 *
 *   // Close the dispatcher when done
 *   statusDispatcher.close();
 * })();
 * ```
 *
 * @see CustomEvent
 * @see ReadableStream
 * @see WritableStream
 * @see TransformStream
 * @see {@link createChannel} for more information on how channels are implemented and their benefits.
 *
 * @public
 */
export function createEventDispatcher<E extends Event = CustomEvent<unknown>>(): EventDispatcher<E> {
  const channel = createChannel<E>();

  return {
    /**
     * Dispatches a status event to the channel.
     * @param event - The status event to dispatch.
     */
    async dispatch(event: E): Promise<void> {
      const writer = channel.getWriter();
      await writer.write(event);
    },

    /**
     * Provides a new readable stream that can be used with `for await...of`
     * to listen to status events.
     *
     * @returns A new readable stream of StatusEvents.
     */
    get events(): MulticastReadableStream<E> {
      return channel.readable;
    },

    /**
     * Disposes of the dispatcher asynchronously, releasing resources.
     */
    [Symbol.asyncDispose]() {
      return channel[Symbol.asyncDispose]();
    },
  };
}

/**
 * Listens for a specific event type from a `ReadableStream` and returns the first matching event.
 * Supports aborting the operation using an `AbortSignal`.
 *
 * This function continuously reads from the provided `ReadableStream` until it finds an event
 * that matches the specified type. It also supports cancellation through an `AbortSignal`,
 * allowing the operation to be aborted if necessary. If the stream ends without a matching
 * event and `throwOnNoMatch` is set to `true`, the function will throw an error.
 *
 * ## AbortSignal Support:
 * If an `AbortSignal` is provided and the operation is aborted:
 * - The function will resolve with the reason for the abortion.
 * - The reader lock will be released before the stream is canceled.
 *
 * ## Lock Handling:
 * The function automatically releases the lock on the stream's reader when the operation completes,
 * either by finding a matching event, reaching the end of the stream, or encountering an abort signal.
 *
 * ## Edge Cases:
 * - If the stream ends without finding a matching event and `throwOnNoMatch` is `false`, the function will return `undefined`.
 * - If the stream is aborted, the function will return the abort reason.
 * - If `throwOnNoMatch` is `true` and no matching event is found, the function will throw an error.
 *
 * @template T - The type of events in the `ReadableStream`.
 * @template K - The specific event type to listen for.
 * @param stream - The `ReadableStream` or `ReadableStreamDefaultReader` to listen to.
 * @param type - The event type to match against the stream's events.
 * @param options.signal - An optional `AbortSignal` to cancel the operation.
 * @param options.throwOnNoMatch - A boolean that, when true, throws an error if none of the events match. Defaults to `false`.
 * @returns A promise that resolves with the first event that matches the specified type, the abort reason, or `undefined` if no match is found and `throwOnNoMatch` is `false`.
 *
 * @example
 * ```typescript
 * const statusEventStream = createStatusEventDispatcher().readable;
 *
 * // Listen for the "Running" status event
 * const runningEvent = await waitForEvent(statusEventStream, Status.Running, {
 *   signal: abortSignal
 * });
 *
 * if (runningEvent) {
 *   console.log('Received running event:', runningEvent);
 * } else {
 *   console.log('No running event received or operation was aborted');
 * }
 * ```
 *
 * @example
 * ```typescript
 * const statusEventStream = createStatusEventDispatcher().readable;
 *
 * // Listen for the "Paused" status event with error handling if no match is found
 * try {
 *   const pausedEvent = await waitForEvent(statusEventStream, Status.Paused, {
 *     signal: abortSignal,
 *     throwOnNoMatch: true
 *   });
 *   console.log('Received paused event:', pausedEvent);
 * } catch (error) {
 *   console.error('Error:', error.message);
 * }
 * ```
 */
export async function waitForEvent<
  T extends Event = CustomEvent<unknown>,
  K extends unknown = unknown
>(
  stream: ReadableStream<T> | ReadableStreamDefaultReader<T>,
  type: K,
  { signal, throwOnNoMatch = false }: WaitForEventOptions = {},
): Promise<T | Event | Error | undefined> {
  const reader = "getReader" in stream ? stream.getReader() : stream;
  let result: ReadableStreamReadResult<T> | AbortedReadableStreamReadDoneResult;

  // Promise that resolves if the signal is aborted
  const abortable = new Promise<AbortedReadableStreamReadDoneResult>(
    (resolve) => {
      if (signal?.aborted) {
        resolve({
          done: true,
          value: { aborted: true, reason: signal.reason },
        });
      } else {
        signal?.addEventListener?.("abort", () => {
          resolve({
            done: true,
            value: { aborted: true, reason: signal.reason },
          });
        }, { once: true });
      }
    },
  );

  try {
    do {
      if (signal?.aborted) return signal.reason;

      // Wait for either a read result or an abort signal
      result = await Promise.race([
        reader.read(),
        abortable,
      ]);

      // Check if the operation was aborted
      if ((result as AbortedReadableStreamReadDoneResult)?.value?.aborted) {
        return (result as AbortedReadableStreamReadDoneResult)?.value?.reason as
          | Error
          | Event;
      }

      // Check if the event matches the desired type
      if ((result as ReadableStreamReadDoneResult<T>)?.value?.type === type) {
        return (result as ReadableStreamReadDoneResult<T>).value;
      }
    } while (!result?.done);
  } finally {
    // Release the reader's lock before attempting to cancel the stream
    reader?.releaseLock?.();
  }

  if (throwOnNoMatch) {
    throw new Error(`Stream ended without receiving event of type: ${type}`);
  }
}

/**
 * Represents the return type of the `createStatusEventDispatcher` function.
 *
 * This interface defines the structure of the dispatcher object, which includes methods for dispatching events,
 * accessing the readable stream of events, and managing the lifecycle of the dispatcher.
 */
export interface EventDispatcher<E extends Event = CustomEvent<unknown>> {
  /**
   * Dispatches a status event to the channel.
   *
   * @param event - The status event to dispatch.
   * @returns A promise that resolves when the event has been dispatched.
   */
  dispatch(event: E): Promise<void>;

  /**
   * Provides a new readable stream that can be used with `for await...of`
   * to listen to status events.
   *
   * @returns A new readable stream of StatusEvents.
   */
  readonly events: MulticastReadableStream<E>;

  /**
   * Disposes of the dispatcher asynchronously, releasing resources.
   *
   * @returns A promise that resolves when the disposal is complete.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Options for the `waitForEvent` function.
 */
export interface WaitForEventOptions {
  /**
   * Whether to throw an error if no matching event is found.
   * @defaultValue false
   */
  throwOnNoMatch?: boolean;

  /**
   * An optional `AbortSignal` to cancel the operation.
   */
  signal?: AbortSignal;
}

/**
 * Represents the result of a `ReadableStream` read operation that was aborted.
 * This type is used internally by the `waitForEvent` function to manage abort signals.
 * @internal
 */
export type AbortedReadableStreamReadDoneResult = ReadableStreamReadDoneResult<
  { aborted: boolean; reason: unknown }
>;
