/**
 * Result type for fallible operations.
 *
 * @module worktree/shared/result
 */

/** Result type for fallible operations */
export interface OkResult<T> {
	readonly ok: true
	readonly value: T
}
export interface ErrResult<E> {
	readonly ok: false
	readonly error: E
}
export type Result<T, E> = OkResult<T> | ErrResult<E>

export const Result = {
	ok: <T>(value: T): OkResult<T> => ({ ok: true, value }),
	err: <E>(error: E): ErrResult<E> => ({ ok: false, error }),
}
