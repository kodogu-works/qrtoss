import type { messages, errorMessages } from './en';

export type Key = keyof typeof messages;
export type Messages = Record<Key, string>;
export type ErrorMessages = Record<keyof typeof errorMessages, string>;
