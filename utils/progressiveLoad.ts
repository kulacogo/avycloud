/** Publish each independent section as soon as it settles; preserve result order. */
export function settleProgressively<T extends readonly unknown[]>(
  requests: { [K in keyof T]: Promise<T[K]> },
  onSettled: (index: number, result: PromiseSettledResult<T[number]>) => void,
): Promise<{ [K in keyof T]: PromiseSettledResult<T[K]> }> {
  return Promise.all(requests.map((request, index) => request.then(
    value => {
      const result = { status: 'fulfilled', value } as const;
      onSettled(index, result);
      return result;
    },
    reason => {
      const result = { status: 'rejected', reason } as const;
      onSettled(index, result);
      return result;
    },
  ))) as Promise<{ [K in keyof T]: PromiseSettledResult<T[K]> }>;
}
