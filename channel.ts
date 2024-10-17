import type { MulticastReadableStream } from "./multicast.ts";
import { createMulticastStream } from "./multicast.ts";

/**
 * Creates a unidirectional communication channel built on Web Streams, allowing data to flow from one or more writers to multiple independent readers.
 *
 * The writable stream is accessible for piping, and readers can be accessed via a getter. The channel can be closed, and the shared writer is accessible via a method.
 * The channel also supports disposal using `Symbol.dispose`.
 *
 * ## Overview
 *
 * A **channel** in this context refers to a communication pathway where data can be sent by one or more producers (writers) and received by one or more consumers (readers).
 * The channel concept is built on top of the **Web Streams API**, which provides the foundational `ReadableStream`, `WritableStream`, and `TransformStream` constructs.
 *
 * The Web Streams API was introduced to standardize streaming data handling in JavaScript, particularly for use cases involving large or continuous data flows, like processing files or handling network data.
 * It allows for more efficient memory usage and better control over data flow compared to older approaches like Promises or callbacks.
 *
 * ### Key Components:
 * - **ReadableStream**: Represents a source of data that you can read from. In this channel, it allows multiple readers to independently consume the same data stream.
 * - **WritableStream**: Represents a destination for data that you can write to. Here, multiple writers can push data into the channel.
 * - **TransformStream**: Combines a `WritableStream` and a `ReadableStream`, allowing data to be modified as it passes through. This stream powers the internal mechanics of the channel.
 *
 * ### Why Use a Channel?
 * Channels built on Web Streams offer a flexible way to manage data flow between multiple producers and consumers. Unlike traditional methods like Promises or callbacks, streams provide built-in support for backpressure and memory efficiency, making them ideal for scenarios where data is being produced or consumed at different rates.
 *
 * ### Weaknesses of Web Streams
 * While powerful, Web Streams can be complex to manage, especially when dealing with multiple readers and writers. The native API does not inherently support multiple readers consuming the same data stream, which is where this `createChannel` utility comes in.
 * It simplifies these tasks by providing a more user-friendly interface for common patterns, such as setting up multiple consumers or sharing a writer among different components.
 *
 * ### Internals of `createChannel`
 * Internally, `createChannel` uses a `TransformStream` to handle data writing and reading. The writable part of this stream is exposed for data input, while the readable part is split into multiple branches using the `ReadableStream.tee()` method.
 * This allows each reader to independently consume the same data stream, with the channel managing the complexity of coordinating these operations.
 *
 * ### Why Not Use Iterators or Generators?
 * While iterators, iterables, and generators are powerful tools in JavaScript, they are not ideal for scenarios involving multiple independent consumers of the same data stream.
 * Web Streams are designed specifically for handling streaming data with built-in support for backpressure, which ensures that producers do not overwhelm consumers, and vice versa. This makes them more suitable for scenarios where data production and consumption rates may vary, as is often the case in real-time applications.
 *
 * ### Methods & Properties:
 * - **writable**: The writable stream where data can be pushed. This stream supports piping and direct writing.
 * - **getWriter()**: Provides access to the shared writer, allowing direct writes to the channel. This is useful when you need explicit control over writing, such as when coordinating between multiple components.
 * - **readable**: A getter that returns a new readable stream each time it is accessed. This allows multiple readers to independently consume the same data stream.
 * - **close()**: Closes the channel by shutting down the writable stream and canceling all active readable branches, ensuring that no more data can be written or read.
 * - **[Symbol.dispose]()**: Implements the disposal protocol, allowing the channel to be cleanly disposed of using the `using` keyword or equivalent patterns in resource management.
 *
 * > [!WARNING]
 * > _Do not pipe to the writable stream and write to it directly at the same time._
 * >
 * > Piping data into the writable stream and manually writing to it simultaneously can lead to conflicts and unpredictable behavior.
 * > Choose one method of writing to the stream to maintain consistent and reliable data flow.
 *
 * @template T - The type of data transmitted through the channel.
 * @returns An object containing the writable stream, a method to get the shared writer, a getter for the readable stream, and methods to close or dispose of the channel.
 *
 * @example Basic Usage
 * ```typescript
 * // Create a channel
 * const channel = createChannel<string>();
 *
 * // Access the shared writer and write data to the channel
 * const writer = channel.getWriter();
 * writer.write("Message 1");
 * writer.write("Message 2");
 *
 * // Set up multiple readers to consume the data from the channel
 * (async () => {
 *   for await (const value of channel.readable) {
 *     console.log("Reader 1 received:", value);
 *   }
 * })();
 *
 * (async () => {
 *   for await (const value of channel.readable) {
 *     console.log("Reader 2 received:", value);
 *   }
 * })();
 *
 * // Close the channel after operations are done
 * channel.close();
 * ```
 *
 * @example Using the `using` Keyword
 * ```typescript
 * // Automatically managing the channel's lifecycle
 * using channel = createChannel<string>();
 *
 * // Writer and reader operations...
 *
 * // The channel is automatically closed and disposed of when the block scope ends
 * ```
 *
 * @example Piping Data into the Channel
 * ```typescript
 * // Piping data into the channel
 * const readable = new ReadableStream({
 *   start(controller) {
 *     controller.enqueue("Piped data 1");
 *     controller.enqueue("Piped data 2");
 *     controller.close();
 *   },
 * });
 *
 * // Pipe the data into the channel's writable stream
 * readable.pipeTo(channel.writable);
 *
 * // Reader consuming the piped data
 * (async () => {
 *   for await (const value of channel.readable) {
 *     console.log("Reader received:", value);
 *   }
 * })();
 * ```
 *
 * @example Using Channels Between Web Workers
 * ```ts
 * // Main thread
 * const channel = createChannel<string>();
 * const worker = new Worker("worker.js");
 * worker.postMessage({ readable: channel.readable }, [channel.readable]);
 *
 * const writer = channel.getWriter();
 * writer.write("Hello from main thread!");
 *
 * channel.close();
 *
 * // worker.js
 * self.addEventListener("message", async (event) => {
 *   const { readable } = event.data;
 *   for await (const message of readable) {
 *     console.log(message); // Logs "Hello from main thread!"
 *   }
 * });
 * ```
 */
export function createChannel<T>(): Channel<T> {
  const transformStream = new TransformStream<T, T>();
  const sharedWriter = transformStream.writable.getWriter();
  const readableStream = transformStream.readable;

  const multicastStream = createMulticastStream(readableStream);

  return {
    /**
     * The writable stream that can be used for piping or writing directly.
     */
    writable: transformStream.writable,

    /**
     * Getter for the readable stream, which supports multiple readers via tee.
     * Each time it's accessed, it provides a new reader wrapped with disposal support.
     *
     * @returns A new readable stream with disposal support.
     */
    readable: multicastStream,

    /**
     * Method to get the shared writer for direct writing.
     * @returns WritableStreamDefaultWriter<T>
     */
    getWriter(): WritableStreamDefaultWriter<T> {
      return sharedWriter;
    },

    /**
     * Asynchronously disposes of the channel resources using the Symbol.asyncDispose protocol.
     * This ensures that all readers are properly canceled and cleaned up asynchronously.
     * @returns A promise that resolves when the disposal is complete.
     */
    async [Symbol.asyncDispose]() {
      await Promise.all([
        sharedWriter.close(), // Close the writable stream
        multicastStream.cancel(),
      ]);
    },
  };
}

/**
 * Creates a bidirectional channel that supports full-duplex communication between two endpoints, leveraging Web Streams.
 *
 * Each endpoint can read and write independently, allowing for full-duplex communication.
 * The channel supports disposal using `Symbol.dispose`.
 *
 * ## Overview
 *
 * A **bidirectional channel** allows for two-way communication between two distinct entities, often referred to as endpoints A and B.
 * This type of communication is essential in scenarios like client-server architectures, where both sides need to send and receive data.
 *
 * The **Web Streams API** is the foundation of this bidirectional channel, utilizing `ReadableStream`, `WritableStream`, and `TransformStream` to handle data flow.
 *
 * ### Key Concepts:
 * - **Full-Duplex Communication**: Both endpoints can send and receive data independently, without blocking each other. This is achieved by using two unidirectional channels internally, one for each direction of communication.
 * - **ReadableStream and WritableStream**: Each endpoint has its own readable and writable streams, allowing for independent data flow in both directions.
 * - **TransformStream**: Used internally to manage the flow of data and ensure that each endpoint's streams are connected appropriately.
 *
 * ### Why Use a Bidirectional Channel?
 * Bidirectional channels are crucial for real-time applications, peer-to-peer communication, and any scenario where two entities need to exchange data continuously.
 * By building on Web Streams, these channels benefit from efficient data handling, backpressure management, and compatibility with other stream-based APIs.
 *
 * ### Weaknesses of Channels and Web Streams
 * While streams provide a powerful abstraction for managing data flow, they can be complex to implement correctly, especially when dealing with multiple readers and writers.
 * Channels, while simplifying some of these complexities, introduce additional overhead in coordinating multiple streams and managing their lifecycle.
 *
 * ### Internals of `createBidirectionalChannel`
 * This function builds on `createChannel`, effectively combining two unidirectional channels to support duplex communication.
 * Each endpoint in the channel has its own writable stream for sending data and a readable stream for receiving data from the other endpoint.
 * This setup ensures that data flows smoothly in both directions without interference.
 *
 * ### Methods & Properties:
 * - **endpointA.writer**: The writable stream for endpoint A, used to send data to endpoint B.
 * - **endpointA.readable**: The readable stream for endpoint A, used to receive data from endpoint B.
 * - **endpointB.writer**: The writable stream for endpoint B, used to send data to endpoint A.
 * - **endpointB.readable**: The readable stream for endpoint B, used to receive data from endpoint A.
 * - **[Symbol.dispose]()**: Implements the disposal protocol, ensuring both endpoints' resources are released when the channel is no longer needed.
 *
 * > [!WARNING]
 * > _Do not pipe to the writable stream and write to it directly at the same time._
 * >
 * > Piping data into the writable stream and manually writing to it simultaneously can lead to conflicts and unpredictable behavior.
 * > Choose one method of writing to the stream to maintain consistent and reliable data flow.
 *
 * @template TRequest - The type of data sent from endpoint A to B.
 * @template TResponse - The type of data sent from endpoint B to A.
 * @returns An object containing methods to access the writable and readable streams for both endpoints and a method to dispose of the channel.
 *
 * @example Basic Bidirectional Communication
 * ```typescript
 * // Create a bidirectional channel for communication between two endpoints
 * const bidirectionalChannel = createBidirectionalChannel<string, string>();
 *
 * // Endpoint A writes a request and reads a response
 * const writerA = bidirectionalChannel.endpointA.writer;
 * const readerA = bidirectionalChannel.endpointA.readable;
 *
 * writerA.write("Request from A");
 *
 * (async () => {
 *   for await (const value of readerA) {
 *     console.log("Endpoint A received:", value);
 *   }
 * })();
 *
 * // Endpoint B reads the request and writes a response
 * const writerB = bidirectionalChannel.endpointB.writer;
 * const readerB = bidirectionalChannel.endpointB.readable;
 *
 * (async () => {
 *   for await (const value of readerB) {
 *     console.log("Endpoint B received:", value);
 *     writerB.write(`Response to ${value}`);
 *   }
 * })();
 *
 * // Dispose of the bidirectional channel when done
 * bidirectionalChannel[Symbol.dispose]();
 * ```
 *
 * @example Using the `using` Keyword
 * ```typescript
 * // Automatically managing the bidirectional channel's lifecycle
 * using bidirectionalChannel = createBidirectionalChannel<string, string>();
 *
 * // Endpoint A writes and reads data
 * bidirectionalChannel.endpointA.writer.write("Request from A");
 *
 * (async () => {
 *   for await (const value of bidirectionalChannel.endpointA.readable) {
 *     console.log("Endpoint A received:", value);
 *   }
 * })();
 *
 * // Endpoint B reads and writes data
 * (async () => {
 *   for await (const value of bidirectionalChannel.endpointB.readable) {
 *     bidirectionalChannel.endpointB.writer.write(`Response to ${value}`);
 *   }
 * })();
 *
 * // The channel is automatically closed and disposed of when the block scope ends
 * ```
 *
 * @example Full-Duplex Communication Example
 * ```typescript
 * // Complex scenario with full-duplex communication between two endpoints
 * const duplexChannel = createBidirectionalChannel<string, string>();
 *
 * // Endpoint A sending multiple requests
 * duplexChannel.endpointA.writer.write("First request");
 * duplexChannel.endpointA.writer.write("Second request");
 *
 * // Endpoint B processing and responding
 * (async () => {
 *   for await (const request of duplexChannel.endpointB.readable) {
 *     console.log("Endpoint B processing:", request);
 *     duplexChannel.endpointB.writer.write(`Response to ${request}`);
 *   }
 * })();
 *
 * // Endpoint A receiving responses
 * (async () => {
 *   for await (const response of duplexChannel.endpointA.readable) {
 *     console.log("Endpoint A received:", response);
 *   }
 * })();
 *
 * // Dispose of the duplex channel when complete
 * duplexChannel[Symbol.dispose]();
 * ```
 */
export function createBidirectionalChannel<
  TRequest,
  TResponse,
>(): BidirectionalChannel<TRequest, TResponse> {
  const channelAtoB = createChannel<TRequest>();
  const channelBtoA = createChannel<TResponse>();

  return {
    /**
     * Endpoint A can write requests and read responses.
     */
    endpointA: {
      get writer() {
        return channelAtoB.getWriter();
      },
      get readable() {
        return channelBtoA.readable;
      },
    },

    /**
     * Endpoint B can write responses and read requests.
     */
    endpointB: {
      get writer() {
        return channelBtoA.getWriter();
      },
      get readable() {
        return channelAtoB.readable;
      },
    },

    /**
     * Asynchronously disposes of the bidirectional channel resources using the Symbol.asyncDispose protocol.
     * This ensures that all streams are closed and resources are released asynchronously.
     * @returns A promise that resolves when the disposal is complete.
     */
    async [Symbol.asyncDispose]() {
      await Promise.all([
        channelAtoB[Symbol.asyncDispose](),
        channelBtoA[Symbol.asyncDispose](),
      ]);
    },
  };
}



/**
 * This module provides utility functions for creating both unidirectional and bidirectional communication channels built on top of Web Streams.
 * The channels enable data flow between one or more producers (writers) and multiple consumers (readers), with support for full-duplex communication in the bidirectional case.
 *
 * The unidirectional `createChannel` function allows multiple independent readers to access the same stream of data written by one or more producers.
 * The bidirectional `createBidirectionalChannel` function enables two endpoints to communicate in a full-duplex manner, each with its own readable and writable streams.
 *
 * Both types of channels support proper resource disposal via `Symbol.dispose`, and the writable streams are accessible for piping or direct writing, while the readable streams allow for multiple independent consumers.
 *
 * The Web Streams API serves as the foundation for these channels, offering efficient handling of continuous or large data flows with built-in backpressure management. This makes them ideal for scenarios such as real-time communication, file processing, or network data streaming.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Streams_API Streams API Documentation} for more details on Web Streams.
 *
 * @module
 */

/**
 * Interface representing a unidirectional communication channel.
 *
 * @template T - The type of data transmitted through the channel.
 */
export interface Channel<T> {
  /**
   * The writable stream that can be used for piping or writing directly.
   */
  readonly writable: WritableStream<T>;

  /**
   * Method to get the shared writer for direct writing.
   * @returns WritableStreamDefaultWriter<T>
   */
  getWriter(): WritableStreamDefaultWriter<T>;

  /**
   * Getter for the readable stream, which supports multiple readers via tee.
   * Each time it's accessed, it provides a new reader wrapped with disposal support.
   *
   * @returns A new readable stream with disposal support.
   */
  readonly readable: MulticastReadableStream<T>;

  /**
   * Asynchronously disposes of the channel resources using the Symbol.asyncDispose protocol.
   * This ensures that all readers are properly canceled and cleaned up asynchronously.
   * @returns A promise that resolves when the disposal is complete.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Interface representing a bidirectional communication channel.
 *
 * @template TRequest - The type of data sent from endpoint A to B.
 * @template TResponse - The type of data sent from endpoint B to A.
 */
export interface BidirectionalChannel<TRequest, TResponse> {
  /**
   * Endpoint A can write requests and read responses.
   */
  readonly endpointA: {
    readonly writer: WritableStreamDefaultWriter<TRequest>;
    readonly readable: MulticastReadableStream<TResponse>;
  };

  /**
   * Endpoint B can write responses and read requests.
   */
  readonly endpointB: {
    readonly writer: WritableStreamDefaultWriter<TResponse>;
    readonly readable: MulticastReadableStream<TRequest>;
  };

  /**
   * Asynchronously disposes of the bidirectional channel resources using the Symbol.asyncDispose protocol.
   * This ensures that all streams are closed and resources are released asynchronously.
   * @returns A promise that resolves when the disposal is complete.
   */
  [Symbol.asyncDispose](): Promise<void>;
}