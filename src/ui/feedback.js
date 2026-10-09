// Feedback: self-dismissing error and success toasts, and the pulse on recalculated stats.
import { state } from '../state.js';

export function showError(msg) {
  const b = document.getElementById('errorBox');
  b.textContent = msg;
  b.classList.remove('ok'); // a success toast may still be up: this one is an error
  b.style.display = 'block';
  clearTimeout(state.errorTimer);
  state.errorTimer = setTimeout(clearError, 6000); // floating toast, self-dismissing
}

export function showToast(msg) {
  const b = document.getElementById('errorBox');
  b.textContent = msg;
  b.classList.add('ok');
  b.style.display = 'block';
  clearTimeout(state.errorTimer);
  state.errorTimer = setTimeout(clearError, 5000);
}

export function withFlash(el) {
  if (!state.flashNext || !el) return;
  el.classList.add('pulse');
  setTimeout(() => el.classList.remove('pulse'), 650);
}

export function clearError() {
  const b = document.getElementById('errorBox');
  b.style.display = 'none';
  b.classList.remove('ok');
}
