export function requiredString(value, field, minLength = 1) {
  const text = String(value || "").trim();
  if (text.length < minLength) {
    return `${field} must be at least ${minLength} characters`;
  }
  return "";
}

export function requiredEmail(value, field = "email") {
  const text = String(value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return `${field} must be a valid email`;
  }
  return "";
}

export function nonNegativeNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return `${field} must be a non-negative number`;
  }
  return "";
}

export function oneOf(value, values, field) {
  if (!values.includes(value)) {
    return `${field} must be one of: ${values.join(", ")}`;
  }
  return "";
}

export function collectErrors(validations) {
  return validations.filter(Boolean);
}
