/**
 * @module multicast
 * 
 * This module enhances the native `ReadableStream` by enabling multiple consumers to 
 * read from a single source stream without duplicating the data. Normally, `ReadableStream` allows 
 * only one reader at a time, and once a stream is locked by a reader, it can't be read by others 
 * simultaneously. This module solves that limitation by allowing multiple consumers (readers) 
 * to access the stream's data without conflicts.
 * 
 * ### Core Idea
 * The main goal of this module is to allow multiple independent consumers to access and read 
 * from the same stream without competing for stream locks. This is achieved by managing multiple 
 * readers and stream controllers through various internal maps and weak maps.
 * 
 * Each time a consumer reads data, the stream distributes the data chunk to all registered 
 * consumers. The system maintains a registry of consumers and controllers, ensuring that 
 * when one consumer pulls data, the same data is made available to all consumers.
 * 
 * ### Why is this necessary?
 * In many scenarios, different subsystems or components need to process the same stream of data. 
 * For example:
 * - In distributed systems, multiple logging systems may need to capture the same data stream for 
 *   monitoring purposes.
 * - In data pipelines, multiple workers may need to consume the same stream of data for parallel 
 *   processing.
 * 
 * However, the native `ReadableStream` only allows a single reader at a time, creating the need for 
 * a system to manage multiple consumers that can read the same data stream independently.
 * 
 * ### Key considerations
 * - **Stream Locking**: Only one reader can lock a stream at a time. This module tracks each reader 
 *   independently to avoid lock conflicts.
 * - **Resource Disposal**: Ensures that resources, such as readers and locks, are properly released 
 *   when consumers are done reading from the stream.
 * - **Asynchronous Disposal**: Handles async operations like canceling readers and releasing locks, 
 *   ensuring proper resource management even in async scenarios.
 * 
 * @example
 * ```ts
 * const sourceStream = new ReadableStream({
 *   // stream initialization 
 * });
 * const multicastStream = createMulticastStream(sourceStream);
 * 
 * // Creating multiple consumers
 * const streamA = createConsumer(multicastStream);
 * const streamB = createConsumer(multicastStream);
 * 
 * // Each consumer can now read independently
 * const readerA = streamA.getReader();
 * const readerB = streamB.getReader();
 * 
 * // Both readers will receive the same data chunks
 * readerA.read().then(console.log); // Consumer 1 reads
 * readerB.read().then(console.log); // Consumer 2 reads
 * ```
 */

import type { DualDisposable } from "./_types.ts";
import { assertNotEquals } from "./_assert.ts";
/**
 * Polyfill for `Symbol.asyncDispose`.
 * 
 * This symbol is used to define an asynchronous disposal method for objects, allowing them to clean up resources asynchronously.
 * If `Symbol.asyncDispose` is not natively available, it falls back to a custom symbol.
 * 
 * @example
 * ```typescript
 * class MyResource {
 *   async [SymbolAsyncDispose]() {
 *     // Asynchronous cleanup logic
 *     await someAsyncCleanupFunction();
 *   }
 * }
 * 
 * async function useResource() {
 *   const resource = new MyResource();
 *   await resource[SymbolAsyncDispose]();
 * }
 * ```
 */
// @ts-expect-error Polyfill for `Symbol.asyncDispose`
export const SymbolAsyncDispose = (Symbol.asyncDispose ??= Symbol.for("Symbol.asyncDispose"));

/**
 * Polyfill for `Symbol.dispose`.
 * 
 * This symbol is used to define a synchronous disposal method for objects, allowing them to clean up resources synchronously.
 * If `Symbol.dispose` is not natively available, it falls back to a custom symbol.
 * 
 * @example
 * ```typescript
 * class MyResource {
 *   [SymbolDispose]() {
 *     // Synchronous cleanup logic
 *     someSyncCleanupFunction();
 *   }
 * }
 * 
 * function useResource() {
 *   const resource = new MyResource();
 *   resource[SymbolDispose]();
 * }
 * ```
 */
// @ts-expect-error Polyfill for `Symbol.dispose`
export const SymbolDispose = (Symbol.dispose ??= Symbol.for("Symbol.dispose"));

/**
 * Global symbol to identify a `MulticastReadableStream` and distinguish it from a regular `ReadableStream`.
 */
export const MULTICAST_STREAM_SYMBOL = Symbol.for("MulticastReadableStream");

/**
 * Global constant to track the original `getReader` method of `ReadableStream`.
 * This is important to retain the default behavior while enhancing it.
 */
const originalReadableStreamGetReader = ReadableStream.prototype.getReader;

/**
 * WeakMaps to track various relationships between source streams, consumers, and readers.
 * 
 * @remarks
 * - **SourceStreamReaders**: Keeps track of the reader that is currently locked on the source stream.
 * - **ConsumerStreams**: Stores a set of all consumer streams that are associated with the source stream.
 * - **ConsumerStreamControllers**: Stores the controllers for the consumer streams.
 * - **ConsumerStreamReaders**: Keeps track of the active readers for each consumer stream.
 */
export const SourceStreamReader = new WeakMap<ReadableStream<unknown>, ReadableStreamDefaultReader<unknown>>();
export const ConsumerStreams = new WeakMap<ReadableStream<unknown>, Set<ReadableStream<unknown>>>();
export const ConsumerStreamControllers = new WeakMap<ReadableStream<unknown>, Set<ReadableStreamDefaultController<unknown>>>();
export const ConsumerStreamReaders = new WeakMap<ReadableStream<unknown>, Map<ReadableStream<unknown>, ReadableStreamReaderWithDisposal<ReadableStreamReader<unknown>>>>();
export const ClosedConsumerStreamReaders = new WeakSet<ReadableStreamReaderWithDisposal<ReadableStreamReader<unknown>>>();

/**
 * Interface for an enhanced `ReadableStream` with disposal capabilities.
 * This allows for proper resource management, ensuring that streams can be canceled and 
 * disposed of both synchronously and asynchronously.
 */
export interface ReadableStreamWithDisposal<T> extends ReadableStream<T>, AsyncDisposable {}

/**
 * Represents a `MulticastReadableStream`, which extends the native `ReadableStream` by adding 
 * support for multiple consumers and custom disposal behavior.
 * 
 * @template T - The type of data that the stream produces.
 */
export type MulticastReadableStream<T = unknown> = Omit<ReadableStreamWithDisposal<T>, "getReader"> & {
  /**
   * A symbol identifying this as an enhanced stream.
   */
  [MULTICAST_STREAM_SYMBOL]: typeof MULTICAST_STREAM_SYMBOL;

  /**
   * Retrieves a reader for the stream, ensuring proper disposal of resources.
   * @returns The reader with disposal capabilities.
   */
  getReader(): ReadableStreamReaderWithDisposal<ReadableStreamDefaultReader<T>, T>;

  /**
   * Overloaded `getReader` that allows passing additional options.
   * @returns The reader with disposal capabilities.
   */
  getReader(...args: Parameters<ReadableStream<T>["getReader"]> | []): ReadableStreamReaderWithDisposal<ReadableStreamReader<T>, T>;
};

/**
 * Represents a `ReadableStreamReader` that includes disposal capabilities, allowing the reader 
 * to be synchronously or asynchronously disposed of when no longer needed.
 * 
 * @template R - The type of the reader.
 * @template T - The type of data being read.
 */
export type ReadableStreamReaderWithDisposal<R extends ReadableStreamReader<T>, T = unknown> = R & DualDisposable;

/**
 * Enhances a `ReadableStream` to support multiple consumers and adds disposal capabilities.
 *
 * @template T - The type of data in the `ReadableStream`.
 * @param stream - The `ReadableStream` to enhance.
 * @returns A new `MulticastReadableStream` with disposal capabilities and support for multiple consumers.
 *
 * @example
 * ```ts
 * const sourceStream = new ReadableStream({
 *   // stream initialization 
 * });
 * const multicastStream = createMulticastStream(sourceStream);
 * 
 * const reader = multicastStream.getReader();
 * reader.read().then(console.log); // Consumer 1 reads
 * 
 * const anotherReader = multicastStream.getReader();
 * anotherReader.read().then(console.log); // Consumer 2 reads
 * ```
 */
export function createMulticastStream<T>(
  stream: ReadableStream<T>,
): MulticastReadableStream<T> {
  assertNotEquals(
    (stream as unknown as Record<PropertyKey, unknown>)[MULTICAST_STREAM_SYMBOL],
    MULTICAST_STREAM_SYMBOL,
    "Stream is already enhanced"
  );

  // Enhancing the provided stream with custom methods for handling multiple consumers
  const multicastStream = Object.assign(stream, {
    [MULTICAST_STREAM_SYMBOL]: MULTICAST_STREAM_SYMBOL,

    /**
     * Custom `getReader` method that manages readers and ensures disposal.
     * It tracks the reader and ensures the proper management of the consumer stream.
     *
     * @param args - Optional parameters for the reader.
     * @returns A reader with disposal support.
     */
    getReader<R extends ReadableStreamReader<T>>(
      this: ReadableStream<T>,
      ...args: Parameters<ReadableStream<T>["getReader"]> | []
    ) {
      // Create a new consumer stream
      const consumer = createConsumer(this);

      // Use the original `getReader` method to create a reader for the consumer stream
      const rawReader = consumer.getReader(...args);

      // Store the original `cancel` and `releaseLock` methods
      const originalCancel = rawReader.cancel;
      const originalReleaseLock = rawReader.releaseLock;

      const reader = Object.assign(rawReader as ReadableStreamReaderWithDisposal<R, T>, {
        /**
         * `releaseLock` method to handle the release of the reader lock.
         * It works the same way the normal reader `releaseLock` works but it also keep track of the reader which was just released 
         * to ensure `System.asyncDisposal`, doesn't try to dispose of the same reader multiple times.
         * 
         * This basically means that the errors you'd expect to see from releaseLocks are still there, 
         * e.g. you can't release a reader that has already been released.
         */
        releaseLock(...args: Parameters<ReadableStreamReader<T>["releaseLock"]>) {
          const result = originalReleaseLock.apply(rawReader, args);
          ClosedConsumerStreamReaders.add(reader);
          return result;
        },

        /**
         * `cancel` method to handle the cancellation of the reader.
         * It works the same way the normal reader `cancel` works but it also keep track of the reader which was just canceled 
         * to ensure `System.asyncDisposal`, doesn't try to dispose of the same reader multiple times.
         * 
         * This basically means that the errors you'd expect to see from cancel are still there,
         * e.g. you can't cancel a reader that has already been canceled.
         */
        cancel(...args: Parameters<ReadableStreamReader<T>["cancel"]>) {
          const result = originalCancel.apply(rawReader, args);
          ClosedConsumerStreamReaders.add(reader);
          return result;
        },

        /**
         * Asynchronously dispose of the reader when done by cancelling the reader.
         * This ensures that the reader is properly cleaned up when no longer needed.
         * It also checks if the reader has already been released to avoid duplicate disposal.
         */
        [Symbol.asyncDispose]() {
          if (ClosedConsumerStreamReaders.has(reader)) {
            return Promise.resolve();
          }
          return originalCancel.call(rawReader, "Symbol.asyncDispose");
        }
      });

      // Track the reader in the ConsumerStreamReaders map for disposal management
      if (!ConsumerStreamReaders.has(this)) {
        ConsumerStreamReaders.set(this, new Map());
      }
      ConsumerStreamReaders.get(this)?.set(consumer, reader);

      return reader;
    },

    /**
     * Custom `cancel` method to handle the cancellation and disposal of the stream.
     * Ensures that all readers and consumers are properly canceled and cleaned up.
     *
     * @param args - Optional arguments for cancellation.
     * @returns A promise that resolves when the stream is fully canceled.
     */
    async cancel(this: ReadableStream<T>, ...args: Parameters<ReadableStream<T>["cancel"]>) {
      const readers = ConsumerStreamReaders.get(this);
      Array.from(readers?.values() ?? [], reader => reader?.releaseLock());

      const reader = SourceStreamReader.get(this);
      await reader?.cancel(...args);
      reader?.releaseLock();

      // Clean up the associated controllers and consumer streams
      ConsumerStreamControllers.get(this)?.clear();
      ConsumerStreams.get(this)?.clear();
      readers?.clear();

      SourceStreamReader.delete(this);
      ConsumerStreamReaders.delete(this);
    },

    /**
     * Provides an asynchronous iterator over the stream, allowing consumers to iterate
     * over the data chunks. It locks and unlocks the reader properly.
     *
     * @yields {Promise<T>} Each chunk of data from the stream.
     */
    async *[Symbol.asyncIterator](this: ReadableStream<T>) {
      const reader = this.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        reader.releaseLock(); // Release the lock when done
      }
    },

    /**
     * Asynchronously disposes of the stream by canceling it and releasing resources.
     * Ensures that resources are properly cleaned up when the stream is no longer needed.
     *
     * @returns A promise that resolves when the stream is fully disposed of.
     */
    [Symbol.asyncDispose](this: ReadableStream<T>) {
      return this.cancel("Sybmol.asyncDispose");
    },
  });

  return multicastStream as MulticastReadableStream<T>;
}

/**
 * Creates a new `ReadableStream` for a consumer from a source stream.
 *
 * This function manages the relationship between the source stream and consumer streams,
 * ensuring that multiple consumers can independently access the data.
 *
 * @template T - The type of data emitted by the stream.
 * @param sourceStream - The source `ReadableStream` to create a consumer stream from.
 * @param opts - (Optional) queuing strategy for the consumer stream.
 * @returns A new `ReadableStream` for the consumer.
 *
 * @example
 * ```ts
 * const sourceStream = createInfiniteStream();
 * const streamA = createConsumer(sourceStream);
 * const streamB = createConsumer(sourceStream);
 * 
 * // streamA and streamB are independent consumers of the sourceStream
 * ```
 */
export function createConsumer<T = unknown>(sourceStream: ReadableStream<T>, opts?: QueuingStrategy<T>): ReadableStream<T> {
  let currentCtrlr: ReadableStreamDefaultController<T> | null = null;

  // Create a new consumer `ReadableStream`
  const consumer = new ReadableStream<T>({
    start(controller) {
      // Track the controller for the consumer stream
      const consumerCtrlrs = ConsumerStreamControllers.get(sourceStream) || new Set();
      consumerCtrlrs.add(currentCtrlr = controller);
      ConsumerStreamControllers.set(sourceStream, consumerCtrlrs);

      // Create a reader for the source stream if not already created
      if (!SourceStreamReader.has(sourceStream)) {
        const sourceStreamReader = originalReadableStreamGetReader.apply(sourceStream) as ReadableStreamDefaultReader<T>;
        SourceStreamReader.set(sourceStream, sourceStreamReader);
      }
    },

    async pull() {
      const sourceStreamReader = SourceStreamReader.get(sourceStream);
      if (!sourceStreamReader) {
        return;
      }

      const consumerStreamCtrlrs = ConsumerStreamControllers.get(sourceStream);
      const consumers = ConsumerStreams.get(sourceStream);

      const { done, value } = await sourceStreamReader.read();
      if (done) {
        // If the stream is done, close the controllers and release locks
        consumerStreamCtrlrs?.forEach(ctrlr => ctrlr.close());
        currentCtrlr = null;
        
        sourceStreamReader.releaseLock();

        consumers?.clear();
        consumerStreamCtrlrs?.clear();

        SourceStreamReader.delete(sourceStream);
        ConsumerStreamControllers.delete(sourceStream);
        ConsumerStreams.delete(sourceStream);
        return;
      }

      // Distribute the value to all consumer controllers
      consumerStreamCtrlrs?.forEach(ctrlr => ctrlr.enqueue(value));
    },

    async cancel(reason) {
      const consumerCtrlrs = ConsumerStreamControllers.get(sourceStream);
      const sourceStreamReader = SourceStreamReader.get(sourceStream);
      const consumers = ConsumerStreams.get(sourceStream);

      console.log({
        reason,
        consumerCtrlrs,
        sourceStreamReader,
        consumers,
      });

      if (consumerCtrlrs && consumerCtrlrs.size > 0 && currentCtrlr) {
        consumerCtrlrs.delete(currentCtrlr!);
        currentCtrlr = null;
      }

      if (consumers && consumers.size > 0 && consumer) {
        consumers.delete(consumer!);
      }

      if (sourceStreamReader && consumerCtrlrs && consumers && (consumerCtrlrs.size <= 0 && consumers.size <= 0)) {
        await sourceStreamReader.cancel(reason);
        sourceStreamReader.releaseLock();

        consumers?.clear();
        consumerCtrlrs?.clear();

        SourceStreamReader.delete(sourceStream);
        ConsumerStreamControllers.delete(sourceStream);
        ConsumerStreams.delete(sourceStream);
      }
    },
  }, opts);

  // Track the consumer stream for the source stream
  const consumers = ConsumerStreams.get(sourceStream) || new Set();
  ConsumerStreams.set(sourceStream, consumers.add(consumer));

  // Return the new consumer stream
  return consumer;
}
