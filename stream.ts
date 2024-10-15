import type { DualDisposable } from "./types.ts";

/**
 * Metadata interface for tracking streams and their relationships.
 */
export interface StreamMetadata<T> {
  id?: string;                       // Optional identifier for debugging.
  available: Promise<boolean>;       // Promise that resolves when the stream is available.
  parent: ReadableStream<T> | null;  // Parent stream, if any.
  children: Set<ReadableStream<T>>;  // Set of child streams.
}

/**
 * Global constants for original ReadableStream methods.
 */
const originalReadableStreamTee = ReadableStream.prototype.tee;
const originalReadableStreamCancel = ReadableStream.prototype.cancel;
const originalReadableStreamGetReader = ReadableStream.prototype.getReader;

// Registry to keep track of streams and their metadata.
export const ReadableStreamRegistry = new WeakMap<ReadableStream<unknown>, StreamMetadata<unknown>>();
// Map to track the current inactive streams associated with each source stream.
export const AvailableReadableStream = new WeakMap<ReadableStream<unknown>, ReadableStream<unknown>>();
// Map to keep count of streams created from each source stream.
export const ReadableStreamCounter = new WeakMap<ReadableStream<unknown>, number>();

/**
 * A WeakMap that stores the `ReadableStreamReader` for a given `ReadableStream`.
 *
 * This map is used to track readers associated with specific streams, ensuring that each
 * stream's reader can be managed and disposed of properly.
 */
// Weak
export const ReadableStreamReader = new WeakMap<
  ReadableStream<unknown>,
  Map<ReadableStream<unknown>, ReadableStreamReaderWithDisposal<ReadableStreamReader<unknown>>>
>();

/**
 * Interface representing an enhanced `ReadableStream` with disposal capabilities.
 */
export interface ReadableStreamWithDisposal<T> extends ReadableStream<T>, AsyncDisposable { }

/**
 * Enhanced ReadableStream type with overloaded `getReader` method
 */
export type EnhancedReadableStream<T = unknown> = Omit<ReadableStreamWithDisposal<T>, "getReader"> & {
  // Overload for default reader
  getReader(): ReadableStreamReaderWithDisposal<ReadableStreamDefaultReader<T>, T>;

  // Overload for BYOB mode
  // getReader(options: { mode: "byob" }): ReadableStreamReaderWithDisposal<ReadableStreamBYOBReader, T>;

  // Overload for general ReadableStreamGetReaderOptions
  // getReader(options?: ReadableStreamGetReaderOptions): ReadableStreamReaderWithDisposal<ReadableStreamReader<T>, T>;

  // Fallback using Parameters of the original getReader method
  getReader(...args: Parameters<ReadableStream<T>["getReader"]> | []): ReadableStreamReaderWithDisposal<ReadableStreamReader<T>, T>;
};

/**
 * Interface representing an enhanced `ReadableStreamReader` with disposal capabilities.
 */
export type ReadableStreamReaderWithDisposal<
  R extends ReadableStreamReader<T>,
  T = unknown
> = R & DualDisposable & {
  stream: ReadableStream<T>
};

/**
 * Enhances the `ReadableStream` by adding disposal capabilities.
 *
 * @template T - The type of data in the `ReadableStream`.
 * @param stream - The `ReadableStream` to wrap and enhance with disposal support.
 * @returns A new `ReadableStream` that includes methods for synchronous and asynchronous disposal.
 */
export function enhanceReadableStream<T>(
  stream: ReadableStream<T>,
): EnhancedReadableStream<T> {
  const enhancedStream = Object.assign(stream, {
    /**
     * Overrides the default `getReader` method to track and manage the reader.
     * Ensures that the reader is properly associated with the stream and can be disposed of.
     *
     * @template R - The type of the reader.
     * @param this - The enhanced `ReadableStream` instance.
     * @param args - Arguments passed to the original `getReader` method.
     * @returns The `ReadableStreamReader` associated with the stream.
     */
    getReader<R extends ReadableStreamReader<T>>(
      this: ReadableStream<T>,
      ...args: Parameters<ReadableStream<T>["getReader"]> | []
    ) {
      const stream = createReadable(this);
      const rawReader = stream.getReader(...args);
      const reader = Object.assign(rawReader as ReadableStreamReaderWithDisposal<R, T>, {
        stream,
        [Symbol.dispose]() {
          return rawReader.releaseLock();
        },
        [Symbol.asyncDispose]() {
          return Promise.resolve(rawReader.releaseLock());
        }
      });

      // Track the reader in the ReadableStreamReader to manage disposal
      if (!ReadableStreamReader.has(this)) {
        ReadableStreamReader.set(this, new Map());
      }

      // Return the enhanced reader
      ReadableStreamReader.get(this)?.set(stream, reader);
      return reader;
    },

    /**
     * Overrides the default `getReader` method to track and manage the reader.
     * Ensures that the reader is properly associated with the stream and can be disposed of.
     *
     * @param this - The `ReadableStream` instance for which the reader is being requested.
     * @param args - Arguments passed to the original `getReader` method.
     * @returns The `ReadableStreamReader` associated with the stream.
     */
    async cancel(this: ReadableStream<T>, ...args: Parameters<ReadableStream<T>["cancel"]>) {
      const readers = ReadableStreamReader.get(this);
      Array.from(
        readers?.values() ?? [],
        reader => reader?.releaseLock()
      );
      await cancelAll(this, ...args);
      readers?.clear();
      ReadableStreamReader.delete(this);
    },

    /**
     * Provides an async iterator over the `ReadableStream`.
     *
     * Note: This method only works with the default reader, not the BYOB reader.
     *
     * @param this - The enhanced `ReadableStream` instance.
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
     * Asynchronous disposal of the `ReadableStream`.
     *
     * This method cancels the stream and releases resources asynchronously. If the stream is
     * locked, the lock is explicitly released before the stream is canceled.
     *
     * @param this - The enhanced `ReadableStream` instance.
     * @returns A promise that resolves when the disposal is complete.
     */
    [Symbol.asyncDispose](this: ReadableStream<T>) {
      return this.cancel();
    },
  });

  return enhancedStream as EnhancedReadableStream<T>;
}

/**
 * Custom `tee` function that splits a `ReadableStream` into two branches with additional control and tracking.
 *
 * This function acts similarly to the native `ReadableStream.tee()` method but provides enhanced functionality
 * such as tracking availability and supporting asynchronous disposal.
 *
 * @typeParam T - The type of data chunks emitted by the stream.
 * @param stream - The original `ReadableStream` to split.
 * @returns A tuple containing two new `ReadableStreams`, a `Promise` that resolves when the streams are available,
 *          and implements `AsyncDisposable` for proper cleanup.
 *
 * @example
 * ```ts
 * const [branch1, branch2, available] = enhancedTee(originalStream);
 * // Use branch1 and branch2 independently
 * ```
 *
 * @remarks
 * This function is designed to work with streams that need enhanced control over cancellation and resource management.
 * It ensures that both branches are properly handled in case of errors or cancellations.
 */
export function enhancedTee<T = unknown>(
  stream: ReadableStream<T>,
  ..._args: Parameters<ReadableStream<T>["tee"]> | []
): [ReadableStream<T>, ReadableStream<T>, Promise<boolean>] & AsyncDisposable {
  // Create two TransformStreams to act as branches.
  // TransformStream allows us to write to its writable end and read from its readable end.
  const branch1 = new TransformStream<T>();
  const branch2 = new TransformStream<T>();

  // Create a promise that will be resolved when the branches are fully set up.
  const { promise: available, resolve } = Promise.withResolvers<boolean>();

  // Start an async function to read from the original stream and write to both branches.
  (async () => {
    // Get a reader from the original stream to read data chunks.
    const reader = originalReadableStreamGetReader.apply(stream) as ReadableStreamDefaultReader<T>;
    // Get writers for both branches to write data into them.
    const writer1 = branch1.writable.getWriter();
    const writer2 = branch2.writable.getWriter();

    try {
      while (true) {
        // Read a chunk from the original stream.
        const { done, value } = await reader.read();
        if (done) {
          // If the original stream is done, close both writers.
          // Use Promise.any to proceed as soon as one writer is closed successfully.
          await Promise.any([
            writer1.close(),
            writer2.close()
          ]);
          break;
        }

        // Write the chunk to both branches.
        // Use Promise.any to proceed as soon as one write is successful.
        // This prevents the read loop from being blocked if one of the branches is slow.
        await Promise.any([
          writer1.write(value),
          writer2.write(value)
        ]);
      }
    } catch (error) {
      // If an error occurs, abort both writers.
      // Use Promise.all to ensure both writers are aborted.
      await Promise.all([
        writer1.abort(error),
        writer2.abort(error)
      ]);
    } finally {
      // Release the locks on the reader and writers.
      reader.releaseLock();
      writer1.releaseLock();
      writer2.releaseLock();
      // Resolve the available promise to signal that the branches are available.
      resolve(true);
    }
  })();

  // Get the readable ends of the TransformStreams to return as the branches.
  const stream1 = branch1.readable;
  const stream2 = branch2.readable;

  // Prepare the result tuple with the two branches and the availability promise.
  const result: [
    ReadableStream<T>,
    ReadableStream<T>,
    Promise<boolean>
  ] = [stream1, stream2, available];

  // Implement AsyncDisposable to allow for proper cleanup.
  return Object.assign(result, {
    async [Symbol.asyncDispose]() {
      const err = new Error("Cancelled");
      // Cancel both branches and wait for them to be available.
      await Promise.all([
        stream1.cancel(err),
        stream2.cancel(err),
        available
      ]);
    }
  });
}

/**
 * Creates a new `ReadableStream<T>` from a source stream, allowing dynamic branching.
 *
 * This function maintains a registry of streams and their relationships, enabling the creation of multiple
 * readable streams from a single source stream. It uses an enhanced tee function to split the current inactive
 * stream into active and inactive branches.
 *
 * @typeParam T - The type of data chunks emitted by the stream.
 * @param sourceStream - The original `ReadableStream` to create a new readable from.
 * @returns A new `ReadableStream<T>` that reads data from the source stream.
 *
 * @example
 * ```ts
 * const sourceStream = createInfiniteStream();
 * const streamA = createReadable(sourceStream);
 * const streamB = createReadable(sourceStream);
 * // Now streamA and streamB are independent readers of the sourceStream.
 * ```
 *
 * @remarks
 * This function keeps track of the current inactive stream associated with the source stream.
 * Each time `createReadable` is called, it splits the current inactive stream into active and inactive branches.
 * The active branch is returned, and the inactive branch becomes the new current inactive stream.
 * This allows for dynamic creation of new readables from the source stream at any time.
 */
export function createReadable<T = unknown>(sourceStream: ReadableStream<T>): ReadableStream<T> {
  // Initialize the count for the sourceStream if not already set
  if (!ReadableStreamCounter.has(sourceStream)) ReadableStreamCounter.set(sourceStream, 0);

  // Get the current inactive stream associated with the sourceStream, or default to the sourceStream
  const currentInactiveStream = AvailableReadableStream.get(sourceStream) as ReadableStream<T> || sourceStream;

  // Use enhancedTee to split the currentInactiveStream into active and inactive branches
  const [active, inactive, available] = enhancedTee<T>(currentInactiveStream);

  // Retrieve the metadata for the currentInactiveStream from the registry
  let sourceNode = ReadableStreamRegistry.get(currentInactiveStream);

  // If the sourceNode doesn't exist, initialize it
  if (!sourceNode) {
    const count = ReadableStreamCounter.get(sourceStream)!;
    // Set metadata for the currentInactiveStream in the registry
    ReadableStreamRegistry.set(currentInactiveStream, (sourceNode = {
      id: `${count}-source`,
      available,
      parent: null,
      children: new Set([active, inactive]),
    }));

    // Optionally mark the sourceStream for debugging purposes
    Object.assign(sourceStream, { source: true });
    // Increment the count for the sourceStream
    ReadableStreamCounter.set(sourceStream, count + 1);
  } else {
    // If the sourceNode exists, update its available promise and add the new branches to its children
    sourceNode.available = available;
    sourceNode.children.add(active);
    sourceNode.children.add(inactive);
  }

  // Get the updated count for naming purposes
  const count = ReadableStreamCounter.get(sourceStream)!;

  // Create metadata for the active branch (the new readable to return)
  ReadableStreamRegistry.set(active, {
    id: `${count}-active`,
    available,
    parent: currentInactiveStream,
    children: new Set(),
  });
  // Optionally assign an id to the active stream for debugging
  Object.assign(active, { id: `${count}-active` });

  // Create metadata for the inactive branch (the new current inactive stream)
  ReadableStreamRegistry.set(inactive, {
    id: `${count}-inactive`,
    available,
    parent: currentInactiveStream,
    children: new Set(),
  });
  // Optionally assign an id to the inactive stream for debugging
  Object.assign(inactive, { id: `${count}-inactive` });

  // Update the currentStreams map with inactive as the new current inactive stream
  AvailableReadableStream.set(sourceStream, inactive);
  // Increment the count for the sourceStream
  ReadableStreamCounter.set(sourceStream, count + 1);

  // Return the active branch as the new readable stream
  return active;
}

/**
 * Cancels all streams starting from the given `sourceStream`, recursively canceling all its children.
 *
 * This function traverses the stream tree starting from the `sourceStream` and cancels each stream,
 * ensuring that resources are properly cleaned up.
 *
 * @typeParam T - The type of data chunks emitted by the streams.
 * @param sourceStream - The original `ReadableStream` from which to start cancellation.
 * @returns A `Promise` that resolves when all streams have been canceled.
 *
 * @example
 * await cancelAll(sourceStream);
 *
 * @remarks
 * This function uses a stack to perform a depth-first traversal of the stream tree.
 * It keeps track of visited streams to prevent processing the same stream multiple times.
 * After canceling each stream, it updates the registry and currentStreams maps accordingly.
 */
export async function cancelAll<T>(sourceStream: ReadableStream<T>, ...args: Parameters<ReadableStream<T>["cancel"]>): Promise<void> {
  // Initialize the stack with the sourceStream
  const stack = [[sourceStream]];
  // Initialize a set to keep track of visited streams
  const visited = new WeakSet<ReadableStream<T>>();

  // Perform a depth-first traversal of the stream tree
  for (let i = 0; i < stack.length; i++) {
    const queue = stack[i];
    const len = queue.length;

    for (let j = 0; j < len; j++) {
      const stream = queue[j];

      if (!visited.has(stream)) {
        // Get the metadata for the stream
        const node = ReadableStreamRegistry.get(stream);
        if (node?.children?.size) {
          // If the stream has children, add them to the stack for later processing
          stack.push(Array.from(node.children) as ReadableStream<T>[]);
        }

        // Mark the stream as visited
        visited.add(stream);
      }
    }
  }

  // Cancel streams in reverse order to ensure proper cleanup
  while (stack.length > 0) {
    // Get the streams at the current level
    const streams = stack.pop();

    // Cancel each stream at this level
    const cancellations = Array.from(streams ?? [], async substream => {
      // Get the metadata for the substream
      const substreamMetadata = ReadableStreamRegistry.get(substream);
      // Cancel the substream, passing its id as a reason (optional)
      await originalReadableStreamCancel.apply(substream, args ?? [substreamMetadata?.id]);

      // Get the parent stream
      const parent = substreamMetadata?.parent!;
      // Get the metadata for the parent
      const metadata = ReadableStreamRegistry.get(parent);
      // Wait for the parent's available promise to ensure it's ready
      await metadata?.available;

      // Remove the substream from the parent's children
      metadata?.children.delete(substream);
      // Remove the substream from the registry
      ReadableStreamRegistry.delete(substream);

      // Return the substream's metadata for debugging or logging
      return Object.assign({}, substreamMetadata, substream);
    });

    // Wait for all cancellations at this level to complete
    await Promise.all(cancellations);
  }

  // Clean up the currentStreams map
  AvailableReadableStream.delete(sourceStream);
  ReadableStreamCounter.delete(sourceStream);
}

/**
 * Custom pipeTo function that works with enhanced streams.
 * Pipes the stream to a writable destination.
 */
export async function enhancedPipeTo<T>(
  stream: ReadableStream<T>,
  destination: WritableStream<T>,
  options?: StreamPipeOptions
): Promise<void> {
  options = options ?? {};
  const { preventClose = false, preventAbort = false, preventCancel = false, signal } = options;

  const reader = stream.getReader();
  const writer = destination.getWriter();

  let shuttingDown = false;
  let currentWrite: Promise<void> = Promise.resolve();

  // Handle abort signal
  if (signal) {
    if (signal.aborted) {
      await abort();
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", () => {
      abort().catch(() => { });
    }, { once: true });
  }

  async function abort() {
    if (shuttingDown) return;
    shuttingDown = true;

    const actions = [];

    if (!preventAbort) {
      actions.push(writer.abort(new DOMException("Aborted", "AbortError")));
    } else {
      actions.push(writer.releaseLock());
    }

    if (!preventCancel) {
      actions.push(reader.cancel(new DOMException("Aborted", "AbortError")));
    } else {
      actions.push(reader.releaseLock());
    }

    await Promise.all(actions);
  }

  async function pipeLoop(): Promise<void> {
    while (true) {
      let readResult: ReadableStreamReadResult<T>;
      try {
        readResult = await reader.read();
        if (readResult.done) {
          break;
        }
      } catch (readError) {
        if (!preventAbort) {
          try {
            await writer.abort(readError);
          } catch {
            // Ignore errors during abort
          }
        }
        throw readError;
      }

      try {
        currentWrite = writer.write(readResult.value);
        await currentWrite;
      } catch (writeError) {
        if (!preventCancel) {
          try {
            await reader.cancel(writeError);
          } catch {
            // Ignore errors during cancel
          }
        }
        throw writeError;
      }
    }
  }

  try {
    await pipeLoop();

    if (!preventClose) {
      await writer.close();
    } else {
      writer.releaseLock();
    }
  } catch (error) {
    // Handle errors already handled in pipeLoop
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}
