const two = (value: number): string => String(value).padStart(2, '0');

/** Local `HH:MM:SS`. */
export const stamp = (date: Date): string => `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
