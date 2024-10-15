import type { EnhancedReadableStream } from "./stream.ts";
import { createChannel } from "./channel.ts";

/**
 * Splits a source ReadableStream into two separate ReadableStreams: one for valid values and one for errors encountered during stream processing.
 *
 * ### Error Handling:
 * - This function catches errors during the enqueueing of values and routes them to the error stream.
 * - Errors occurring during the transformation process will be sent to the error stream.
 * - Valid values will continue to flow into the valid stream, ensuring that processing can continue even in the presence of errors.
 *
 * ### Disposal:
 * - Each resulting stream supports multiple readers, and they will automatically handle resource cleanup once all consumers have finished reading.
 * - The channels used to manage the streams are properly disposed of when the streams are closed or no longer needed.
 *
 * @template V The type of data contained in the source stream.
 * @template E The type of errors encountered during stream processing.
 * @param source The original source ReadableStream to be split.
 * @returns An array containing two ReadableStreams:
 * - The first stream for valid values.
 * - The second stream for errors encountered during stream processing.
 *
 * @example
 * ```ts
 * import { splitStream } from "./stream.ts"
 * 
 * // Example source stream with valid values and an error
 * const sourceStream = new ReadableStream({
 *   start(controller) {
 *     controller.enqueue("Valid value 1");
 *     controller.enqueue("Valid value 2");
 *     controller.error(new Error("Something went wrong"));
 *     controller.close();
 *   }
 * });
 *
 * const [validStream, errorStream] = splitStream(sourceStream);
 *
 * // Reading from the valid stream
 * const validReader = validStream.getReader();
 * validReader.read().then(({ value }) => console.log("Valid:", value)); // Logs: "Valid value 1"
 *
 * // Reading from the error stream
 * const errorReader = errorStream.getReader();
 * errorReader.read().then(({ value }) => console.error("Error:", value)); // Logs: Error: Something went wrong
 * ```
 */
export function splitStream<V, E = unknown>(
  source: ReadableStream<V>,
):
  & readonly [EnhancedReadableStream<V>, EnhancedReadableStream<E>]
  & AsyncDisposable {
  // Create channels for valid values and errors
  const validChannel = createChannel<V>();
  const errorChannel = createChannel<E>();

  // Transformer to manage the splitting logic
  const transformer = new TransformStream<V, E>({
    async transform(chunk) {
      try {
        // Attempt to enqueue the chunk into the valid channel
        await validChannel.getWriter().write(chunk);
      } catch (error) {
        // If an error occurs, enqueue the error into the error channel
        await errorChannel.getWriter().write(error as E);
      }
    },
    async flush() {
      // Close both channels when the stream is done
      await Promise.all([
        validChannel[Symbol.asyncDispose](),
        errorChannel[Symbol.asyncDispose]()
      ]);
    },
  });

  // Pipe the source through the transformer
  source.pipeThrough(transformer);

  // Return the two readable streams wrapped with disposables
  return Object.assign(
    [validChannel.readable, errorChannel.readable] as const,
    {
      async [Symbol.asyncDispose]() {
        await Promise.all([
          validChannel[Symbol.asyncDispose](),
          errorChannel[Symbol.asyncDispose]()
        ]);
      },
    },
  );
}

/**
 * Splits a source ReadableStream into two separate ReadableStreams based on a predicate function.
 *
 * ### Predicate-Based Splitting:
 * - The source stream is evaluated chunk by chunk using the provided predicate function.
 * - Chunks that satisfy the predicate are routed to the first stream.
 * - Chunks that do not satisfy the predicate are routed to the second stream.
 *
 * ### Disposal:
 * - Each resulting stream supports multiple readers and will automatically handle resource cleanup once all consumers have finished reading.
 * - The channels used to manage the streams are properly disposed of when the streams are closed or no longer needed.
 *
 * @template T The type of data contained in the source stream.
 * @param source The original source ReadableStream to be split.
 * @param predicate A function that evaluates each chunk and returns a boolean. `true` means the chunk goes to the first stream, `false` means it goes to the second stream.
 * @returns An array containing two ReadableStreams:
 * - The first stream contains chunks that satisfied the predicate.
 * - The second stream contains chunks that did not satisfy the predicate.
 *
 * @example
 * ```ts
 * import { splitByStream } from "./stream.ts"
 * 
 * // Example source stream with numbers
 * const sourceStream = new ReadableStream({
 *   start(controller) {
 *     controller.enqueue(1);
 *     controller.enqueue(2);
 *     controller.enqueue(3);
 *     controller.enqueue(4);
 *     controller.close();
 *   }
 * });
 *
 * const isEven = (value: number) => value % 2 === 0;
 * const [evenStream, oddStream] = splitByStream(sourceStream, isEven);
 *
 * // Reading from the even stream
 * const evenReader = evenStream.getReader();
 * evenReader.read().then(({ value }) => console.log("Even:", value)); // Logs: 2
 *
 * // Reading from the odd stream
 * const oddReader = oddStream.getReader();
 * oddReader.read().then(({ value }) => console.log("Odd:", value)); // Logs: 1
 * ```
 */
export function splitByStream<T, F = unknown>(
  source: ReadableStream<T | F>,
  predicate: (chunk: T | F) => boolean | PromiseLike<boolean>,
):
  & readonly [EnhancedReadableStream<T>, EnhancedReadableStream<F>]
  & AsyncDisposable {
  // Create channels for true and false predicate results
  const trueChannel = createChannel<T>();
  const falseChannel = createChannel<F>();

  // Transformer to manage the splitting logic based on the predicate
  const transformer = new TransformStream<T | F, T | F>({
    async transform(chunk) {
      // Route chunks based on the predicate
      if (await predicate(chunk)) {
        trueChannel.getWriter().write(chunk as T);
      } else {
        falseChannel.getWriter().write(chunk as F);
      }
    },
    async flush() {
      // Close both channels when the stream is done
      await Promise.all([
        trueChannel[Symbol.asyncDispose](),
        falseChannel[Symbol.asyncDispose](),
      ]);
    },
  });

  // Pipe the source through the transformer
  source.pipeThrough(transformer);

  // Return the two readable streams wrapped with disposables
  return Object.assign([trueChannel.readable, falseChannel.readable] as const, {
    async [Symbol.asyncDispose]() {
      await Promise.all([
        trueChannel[Symbol.asyncDispose](),
        falseChannel[Symbol.asyncDispose](),
      ]);
    },
  });
}
