export function normalizeNonEmptyString(value: string): string | undefined {
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

export function normalizeOptionalNonEmptyString(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = normalizeNonEmptyString(value);
  if (trimmedValue === undefined) {
    throw new Error(`${fieldName} cannot be empty.`);
  }

  return trimmedValue;
}
