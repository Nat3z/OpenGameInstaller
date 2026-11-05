import { styleText } from 'node:util';
import { Effect, Stream } from 'effect';
import type { Scope } from 'effect/Scope';

export type LogSource = 'app' | 'addon' | 'prereqs';
type Chunk = string | Uint8Array;

// chunks each view keeps for redrawing when switched to
const MAX_CHUNKS: number = 2000;
const CLEAR_SCREEN: string = '\x1B[2J\x1B[3J\x1B[H';
const SAVE_CURSOR: string = '\x1B7';
const RESTORE_CURSOR: string = '\x1B8';
const CLEAR_LINE: string = '\x1B[2K';
const CTRL_C: string = '\u0003';

/** Splits app, addon and pre-requisite output into views that tab cycles. */
export class LogViews {
  // pipes and ci can't take keypresses, so their output stays interleaved
  public readonly interactive: boolean = Boolean(
    process.stdin.isTTY && process.stdout.isTTY
  );
  private readonly buffers: Record<LogSource, Chunk[]> = {
    app: [],
    addon: [],
    prereqs: [],
  };
  private active: LogSource;

  /** Views in tab order; the first one starts active. */
  constructor(private readonly sources: LogSource[]) {
    this.active = sources[0]!;
  }

  private next(): LogSource {
    const index: number = this.sources.indexOf(this.active);
    return this.sources[(index + 1) % this.sources.length]!;
  }

  write(source: LogSource, data: Chunk): void {
    if (!this.interactive) {
      process.stdout.write(data);
      return;
    }
    const buffer = this.buffers[source];
    buffer.push(data);
    if (buffer.length > MAX_CHUNKS) buffer.shift();
    if (source === this.active) process.stdout.write(data);
  }

  /** Empties a view, e.g. when the addon reloads. */
  clear(source: LogSource): void {
    this.buffers[source].length = 0;
    if (source === this.active) this.show(source);
  }

  private rows(): number {
    return process.stdout.rows || 24;
  }

  /** Redraws the terminal with a view's buffered output. */
  show(source: LogSource): void {
    this.active = source;
    if (!this.interactive) return;
    // logs scroll above the bottom row; setting the region homes the cursor
    process.stdout.write(`${CLEAR_SCREEN}\x1B[1;${this.rows() - 1}r`);
    this.drawBar();
    for (const chunk of this.buffers[source]) process.stdout.write(chunk);
  }

  /** Draws the tab reminder on the bottom row, outside the scrolling logs. */
  private drawBar(): void {
    const text: string = `${this.active} logs · tab for ${this.next()} logs · ctrl+c to quit`;
    const bar: string = styleText(
      ['gray'],
      text.slice(0, process.stdout.columns || 80)
    );
    process.stdout.write(
      `${SAVE_CURSOR}\x1B[${this.rows()};1H${CLEAR_LINE}${bar}${RESTORE_CURSOR}`
    );
  }

  /** Gives the whole screen back to the shell and clears the bar. */
  private releaseBar(): void {
    process.stdout.write(
      `${SAVE_CURSOR}\x1B[r\x1B[${this.rows()};1H${CLEAR_LINE}${RESTORE_CURSOR}`
    );
  }

  /**
   * Switches views on tab until ctrl+c, which raw mode no longer turns into
   * SIGINT. Never resolves when the terminal isn't interactive.
   */
  keys(): Effect.Effect<void, never, Scope> {
    if (!this.interactive) return Effect.never;
    const stdin = process.stdin;
    // a resize moves the bottom row, so redraw the region and bar
    const onResize = (): void => this.show(this.active);
    const restore = (): void => {
      process.stdout.off('resize', onResize);
      this.releaseBar();
      stdin.setRawMode(false);
      stdin.pause();
    };

    return Effect.gen(this, function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          stdin.setRawMode(true);
          stdin.setEncoding('utf8');
          stdin.resume();
          process.stdout.on('resize', onResize);
          // process.exit skips finalizers, so restore the terminal there too
          process.once('exit', restore);
        }),
        () =>
          Effect.sync(() => {
            process.off('exit', restore);
            restore();
          })
      );

      yield* Stream.async<string>((emit) => {
        const onData = (key: string): void => void emit.single(key);
        stdin.on('data', onData);
        return Effect.sync(() => stdin.off('data', onData));
      }).pipe(
        Stream.takeWhile((key) => key !== CTRL_C),
        Stream.runForEach((key) =>
          Effect.sync(() => {
            if (key === '\t') this.show(this.next());
          })
        )
      );
    });
  }
}
