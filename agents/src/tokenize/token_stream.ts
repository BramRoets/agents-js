// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { TokenData } from './tokenizer.js';
import { SentenceStream, WordStream } from './tokenizer.js';

type TokenizeFunc = (x: string) => string[] | [string, number, number][];

export class BufferedTokenStream implements AsyncIterableIterator<TokenData> {
  protected queue = new TransformStream<TokenData, TokenData>();
  protected closed = false;

  #func: TokenizeFunc;
  #minTokenLength: number;
  #minContextLength: number;
  #bufTokens: string[] = [];
  #inBuf = '';
  #outBuf = '';
  #currentSegmentId: string;

  constructor(func: TokenizeFunc, minTokenLength: number, minContextLength: number) {
    this.#func = func;
    this.#minTokenLength = minTokenLength;
    this.#minContextLength = minContextLength;

    this.#currentSegmentId = randomUUID();
  }

  /** Push a string of text into the token stream */
  pushText(text: string) {
    if (this.closed) {
      throw new Error('Stream is closed');
    }

    const writer = this.queue.writable.getWriter();

    this.#inBuf += text;
    if (this.#inBuf.length < this.#minContextLength) return;

    while (true) {
      const tokens = this.#func(this.#inBuf);
      if (tokens.length <= 1) break;

      if (this.#outBuf) this.#outBuf += ' ';

      const tok = tokens.shift()!;
      let tokText = tok as string;
      if (tok.length > 1 && typeof tok[1] === 'number') {
        tokText = tok[0];
      }

      this.#outBuf += tokText;
      if (this.#outBuf.length >= this.#minTokenLength) {
        writer.write({ token: this.#outBuf, segmentId: this.#currentSegmentId });
        this.#outBuf = '';
      }

      if (typeof tok! !== 'string') {
        this.#inBuf = this.#inBuf.slice(tok![2]);
      } else {
        this.#inBuf = this.#inBuf
          .slice(Math.max(0, this.#inBuf.indexOf(tok)) + tok.length)
          .trimStart();
      }
    }
  }

  /** Flush the stream, causing it to process all pending text */
  flush() {
    if (this.closed) {
      throw new Error('Stream is closed');
    }

    const writer = this.queue.writable.getWriter();

    if (this.#inBuf || this.#outBuf) {
      const tokens = this.#func(this.#inBuf);
      if (tokens) {
        if (this.#outBuf) this.#outBuf += ' ';

        if (typeof tokens[0] !== 'string') {
          this.#outBuf += tokens.map((tok) => tok[0]).join(' ');
        } else {
          this.#outBuf += tokens.join(' ');
        }
      }

      if (this.#outBuf) {
        writer.write({ token: this.#outBuf, segmentId: this.#currentSegmentId });
      }

      this.#currentSegmentId = randomUUID();
    }

    this.#inBuf = '';
    this.#outBuf = '';
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.flush();
    this.close();
  }

  async next(): Promise<IteratorResult<TokenData>> {
    return this.queue.readable
      .getReader()
      .read()
      .then(({ value }) => {
        if (value) {
          return { value, done: false };
        } else {
          return { value: undefined, done: true };
        }
      });
  }

  /** Close both the input and output of the token stream */
  close() {
    this.queue.writable.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): BufferedTokenStream {
    return this;
  }
}

export class BufferedSentenceStream extends SentenceStream {
  #stream: BufferedTokenStream;

  constructor(func: TokenizeFunc, minTokenLength: number, minContextLength: number) {
    super();
    this.#stream = new BufferedTokenStream(func, minTokenLength, minContextLength);
  }

  pushText(text: string) {
    this.#stream.pushText(text);
  }

  flush() {
    this.#stream.flush();
  }

  close() {
    super.close();
    this.#stream.close();
  }

  next(): Promise<IteratorResult<TokenData>> {
    return this.#stream.next();
  }
}

export class BufferedWordStream extends WordStream {
  #stream: BufferedTokenStream;

  constructor(func: TokenizeFunc, minTokenLength: number, minContextLength: number) {
    super();
    this.#stream = new BufferedTokenStream(func, minTokenLength, minContextLength);
  }

  pushText(text: string) {
    this.#stream.pushText(text);
  }

  flush() {
    this.#stream.flush();
  }

  endInput() {
    this.#stream.endInput();
  }

  close() {
    this.#stream.close();
  }

  next(): Promise<IteratorResult<TokenData>> {
    return this.#stream.next();
  }
}
