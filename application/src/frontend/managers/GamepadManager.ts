export class GamepadNavigator {
  focusableElements: HTMLElement[] = [];
  currentElement: HTMLElement | null = null; // Explicit tracking
  deadzone: number = 0.3; // Ignore small analog stick movements
  releaseThreshold: number = 0.15; // Lower threshold for detecting stick release (hysteresis)
  repeatDelay: number = 250; // ms between repeated navigation when held
  initialDelay: number = 400; // ms before first repeat when held
  lastNavigationTime: number = 0;
  isNavigating: boolean = false; // Track if we're currently in a navigation
  currentDirection: 'up' | 'down' | 'left' | 'right' | null = null; // Track active navigation direction
  gamepadLoop: NodeJS.Timeout | null = null;
  // Track button states for edge detection (only trigger on initial press)
  aButtonWasPressed: boolean = false;
  bButtonWasPressed: boolean = false;
  // Scroll speed for right stick scrolling (pixels per frame)
  scrollSpeed: number = 15;
  // Weight for perpendicular offset in spatial navigation
  perpendicularWeight: number = 2;
  // Bonus multiplier for elements that overlap on perpendicular axis
  overlapBonus: number = 0.5;

  init() {
    // Poll for gamepad input (Gamepad API uses polling model)
    this.gamepadLoop = setInterval(() => this.update(), 16); // ~60fps

    // Build initial focusable element list
    this.refreshFocusableElements();

    // Listen for DOM changes
    const observer = new MutationObserver(() =>
      this.refreshFocusableElements()
    );
    observer.observe(document.body, { childList: true, subtree: true });

    // Sync with external focus changes (e.g., mouse clicks, tab key)
    document.addEventListener('focusin', this.handleExternalFocus.bind(this));
    console.log('GamepadManager initialized');
  }

  handleExternalFocus(event: FocusEvent) {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      this.focusableElements.includes(target)
    ) {
      this.currentElement = target;
      this.addFocusHighlight(target);
    }
  }

  refreshFocusableElements() {
    this.focusableElements = Array.from(
      document.querySelectorAll(
        'button, [role="button"], a, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => {
      if (
        el instanceof HTMLButtonElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        return !el.disabled && el.offsetParent !== null;
      }
      return el instanceof HTMLElement && el.offsetParent !== null;
    }) as HTMLElement[];

    // Get the top layer elements for focus validation
    const topLayerElements = this.getTopLayerElements();

    // Validate current element is still in the top layer
    if (
      this.currentElement &&
      !topLayerElements.includes(this.currentElement)
    ) {
      this.currentElement = null;
    }

    // Apply focus to first element in top layer if none focused
    if (!this.currentElement && topLayerElements.length > 0) {
      this.focusElement(topLayerElements[0]);
    }
  }

  update() {
    const gamepad = navigator.getGamepads()[0]; // Get first connected gamepad
    if (!gamepad) return;

    const now = Date.now();

    // Get direction from D-pad buttons OR analog stick
    let direction: 'up' | 'down' | 'left' | 'right' | null = null;

    // D-pad buttons (standard mapping: 12=up, 13=down, 14=left, 15=right)
    if (gamepad.buttons[12]?.pressed) direction = 'up';
    else if (gamepad.buttons[13]?.pressed) direction = 'down';
    else if (gamepad.buttons[14]?.pressed) direction = 'left';
    else if (gamepad.buttons[15]?.pressed) direction = 'right';

    // Left analog stick (fallback if no D-pad input)
    if (!direction) {
      const horizontal = gamepad.axes[0];
      const vertical = gamepad.axes[1];

      // Use hysteresis: if already navigating, use release threshold; otherwise use deadzone
      const threshold = this.currentDirection
        ? this.releaseThreshold
        : this.deadzone;

      if (Math.abs(vertical) > threshold) {
        direction = vertical > 0 ? 'down' : 'up';
      } else if (Math.abs(horizontal) > threshold) {
        direction = horizontal > 0 ? 'right' : 'left';
      }
    }

    // Handle navigation with proper debouncing
    if (direction) {
      const timeSinceLastNav = now - this.lastNavigationTime;
      const delay = this.isNavigating ? this.repeatDelay : this.initialDelay;

      if (!this.isNavigating || timeSinceLastNav >= delay) {
        this.navigate(direction);
        this.lastNavigationTime = now;
        this.isNavigating = true;
        this.currentDirection = direction;
      }
    } else {
      // Reset when no direction is pressed (stick/d-pad released)
      // For analog stick, only reset if below release threshold
      if (this.currentDirection) {
        const horizontal = gamepad.axes[0];
        const vertical = gamepad.axes[1];
        const maxAxis = Math.max(Math.abs(horizontal), Math.abs(vertical));

        // Only reset if stick has returned below release threshold
        if (maxAxis < this.releaseThreshold) {
          this.isNavigating = false;
          this.currentDirection = null;
        }
      } else {
        // D-pad was used, reset immediately
        this.isNavigating = false;
        this.currentDirection = null;
      }
    }

    // Button presses (A and B) - edge detection to prevent repeat triggers
    const aPressed = gamepad.buttons[0]?.pressed ?? false;
    const bPressed = gamepad.buttons[1]?.pressed ?? false;

    if (aPressed && !this.aButtonWasPressed) {
      // A button / Cross - only on initial press
      this.activateCurrentElement();
    }
    if (bPressed && !this.bButtonWasPressed) {
      // B button / Circle - only on initial press
      this.goBack();
    }

    // Update button states for next frame
    this.aButtonWasPressed = aPressed;
    this.bButtonWasPressed = bPressed;

    // Right stick scrolling (axes 2 and 3)
    const rightStickX = gamepad.axes[2] ?? 0;
    const rightStickY = gamepad.axes[3] ?? 0;

    if (
      Math.abs(rightStickX) > this.deadzone ||
      Math.abs(rightStickY) > this.deadzone
    ) {
      const scrollContainer = this.findScrollableAncestor(
        this.getCurrentElement()
      );
      if (scrollContainer) {
        // Apply scroll based on right stick position
        if (Math.abs(rightStickY) > this.deadzone) {
          scrollContainer.scrollTop += rightStickY * this.scrollSpeed;
        }
        if (Math.abs(rightStickX) > this.deadzone) {
          scrollContainer.scrollLeft += rightStickX * this.scrollSpeed;
        }
      }
    }
  }

  /**
   * Find the nearest scrollable ancestor of an element
   */
  findScrollableAncestor(element: HTMLElement | null): HTMLElement | null {
    if (!element) return null;

    let current: HTMLElement | null = element.parentElement;

    while (current) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;

      const isScrollableY =
        (overflowY === 'auto' || overflowY === 'scroll') &&
        current.scrollHeight > current.clientHeight;
      const isScrollableX =
        (overflowX === 'auto' || overflowX === 'scroll') &&
        current.scrollWidth > current.clientWidth;

      if (isScrollableY || isScrollableX) {
        return current;
      }

      current = current.parentElement;
    }

    // Fallback to document body or scrolling element
    return document.scrollingElement as HTMLElement;
  }

  getAxisValue(axis: number) {
    return Math.abs(axis) > this.deadzone ? axis : 0;
  }

  getCurrentElement(): HTMLElement | null {
    const topLayerElements = this.getTopLayerElements();

    // If we have explicit tracking and element is still valid AND in the top layer
    if (this.currentElement && topLayerElements.includes(this.currentElement)) {
      return this.currentElement;
    }

    // Fallback: sync with document.activeElement if it's in the top layer
    const active = document.activeElement;
    if (active instanceof HTMLElement && topLayerElements.includes(active)) {
      this.currentElement = active;
      return active;
    }

    // Last resort: first focusable element in the top layer
    if (topLayerElements.length > 0) {
      this.currentElement = topLayerElements[0];
      return topLayerElements[0];
    }

    return null;
  }

  getElementCenter(rect: DOMRect): { x: number; y: number } {
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  /**
   * Get the effective z-index of an element by walking up the DOM tree
   * and finding the highest z-index in its stacking context
   */
  getEffectiveZIndex(element: HTMLElement): number {
    let el: HTMLElement | null = element;
    let maxZIndex = 0;

    while (el) {
      const style = window.getComputedStyle(el);
      const zIndex = style.zIndex;

      if (zIndex !== 'auto') {
        const parsed = parseInt(zIndex, 10);
        if (!isNaN(parsed) && parsed > maxZIndex) {
          maxZIndex = parsed;
        }
      }

      el = el.parentElement;
    }

    return maxZIndex;
  }

  /**
   * Get only the focusable elements in the topmost z-index layer.
   * This ensures navigation is confined to modals/overlays when they're open.
   * Uses a threshold to distinguish overlay layers (z >= 40) from layout z-indices (z < 40).
   */
  getTopLayerElements(): HTMLElement[] {
    if (this.focusableElements.length === 0) return [];

    // Threshold for considering something an "overlay layer" (modals, dialogs, etc.)
    // Layout z-indices (like z-10 for carousel arrows) should not create separate layers
    const overlayThreshold = 40;

    // Group elements by their effective z-index
    const elementsWithZIndex = this.focusableElements.map((el) => ({
      element: el,
      zIndex: this.getEffectiveZIndex(el),
    }));

    // Find the maximum z-index
    const maxZIndex = Math.max(...elementsWithZIndex.map((e) => e.zIndex));

    // If max z-index is below threshold, return all elements (no overlay is open)
    if (maxZIndex < overlayThreshold) {
      return this.focusableElements;
    }

    // An overlay is open - return only elements at or above the threshold
    // that are in the highest layer
    return elementsWithZIndex
      .filter((e) => e.zIndex === maxZIndex)
      .map((e) => e.element);
  }

  isElementInDirection(
    currentCenter: { x: number; y: number },
    targetCenter: { x: number; y: number },
    direction: 'up' | 'down' | 'left' | 'right'
  ): boolean {
    // Simple center-based direction check
    switch (direction) {
      case 'up':
        return targetCenter.y < currentCenter.y;
      case 'down':
        return targetCenter.y > currentCenter.y;
      case 'left':
        return targetCenter.x < currentCenter.x;
      case 'right':
        return targetCenter.x > currentCenter.x;
    }
  }

  hasPerpendicularOverlap(
    currentRect: DOMRect,
    targetRect: DOMRect,
    direction: 'up' | 'down' | 'left' | 'right'
  ): boolean {
    if (direction === 'up' || direction === 'down') {
      // Check x-axis overlap for vertical navigation
      return (
        currentRect.left < targetRect.right &&
        currentRect.right > targetRect.left
      );
    } else {
      // Check y-axis overlap for horizontal navigation
      return (
        currentRect.top < targetRect.bottom &&
        currentRect.bottom > targetRect.top
      );
    }
  }

  getPerpendicularOffset(
    currentRect: DOMRect,
    targetRect: DOMRect,
    direction: 'up' | 'down' | 'left' | 'right'
  ): number {
    if (direction === 'up' || direction === 'down') {
      // For vertical navigation, measure horizontal offset
      const currentCenterX = currentRect.left + currentRect.width / 2;
      const targetCenterX = targetRect.left + targetRect.width / 2;
      return Math.abs(targetCenterX - currentCenterX);
    } else {
      // For horizontal navigation, measure vertical offset
      const currentCenterY = currentRect.top + currentRect.height / 2;
      const targetCenterY = targetRect.top + targetRect.height / 2;
      return Math.abs(targetCenterY - currentCenterY);
    }
  }

  getEdgeDistance(
    currentRect: DOMRect,
    targetRect: DOMRect,
    direction: 'up' | 'down' | 'left' | 'right'
  ): number {
    // Calculate edge-to-edge distance (exit edge to entry edge)
    // Returns positive values for valid directions, can be negative for overlapping elements
    switch (direction) {
      case 'up':
        return currentRect.top - targetRect.bottom;
      case 'down':
        return targetRect.top - currentRect.bottom;
      case 'left':
        return currentRect.left - targetRect.right;
      case 'right':
        return targetRect.left - currentRect.right;
    }
  }

  calculateDistanceScore(
    currentRect: DOMRect,
    targetRect: DOMRect,
    direction: 'up' | 'down' | 'left' | 'right'
  ): number {
    // Get edge-to-edge distance (primary axis)
    let primaryDistance = this.getEdgeDistance(
      currentRect,
      targetRect,
      direction
    );

    // If edge distance is negative (overlapping), use a small positive value
    // This allows selecting overlapping elements but with lower priority
    if (primaryDistance < 0) {
      primaryDistance = Math.abs(primaryDistance) + 1;
    }

    // Get perpendicular offset (how far off-axis the target is)
    const perpOffset = this.getPerpendicularOffset(
      currentRect,
      targetRect,
      direction
    );

    // Base score: primary distance + weighted perpendicular offset
    let score = primaryDistance + perpOffset * this.perpendicularWeight;

    // Strong bonus for elements that overlap on perpendicular axis (aligned elements)
    if (this.hasPerpendicularOverlap(currentRect, targetRect, direction)) {
      score *= this.overlapBonus;
    }

    return score;
  }

  findNearestElement(
    direction: 'up' | 'down' | 'left' | 'right'
  ): HTMLElement | null {
    const current = this.getCurrentElement();
    if (!current) return null;

    const currentRect = current.getBoundingClientRect();
    const currentCenter = this.getElementCenter(currentRect);

    let bestCandidate: HTMLElement | null = null;
    let bestScore = Infinity;

    // Only navigate within the topmost z-index layer (respects modals/overlays)
    const navigableElements = this.getTopLayerElements();

    for (const element of navigableElements) {
      if (element === current) continue;

      const rect = element.getBoundingClientRect();
      const center = this.getElementCenter(rect);

      // Check if element is in the correct direction (center-based)
      if (!this.isElementInDirection(currentCenter, center, direction)) {
        continue;
      }

      // Calculate distance score
      const score = this.calculateDistanceScore(currentRect, rect, direction);

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = element;
      }
    }

    return bestCandidate;
  }

  navigate(direction: 'down' | 'up' | 'left' | 'right') {
    if (this.focusableElements.length === 0) return;

    const nextElement = this.findNearestElement(direction);
    if (nextElement) {
      this.focusElement(nextElement);
    }
    // If no element found in that direction, do nothing (no wrap-around)
  }

  focusElement(element: HTMLElement) {
    if (element) {
      // Update explicit tracking first
      this.currentElement = element;

      element.focus();
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Visual feedback
      this.addFocusHighlight(element);
    }
  }

  addFocusHighlight(element: HTMLElement) {
    // Remove previous highlights
    document.querySelectorAll('.gamepad-focus').forEach((el) => {
      el.classList.remove('gamepad-focus');
    });

    element.classList.add('gamepad-focus');
  }

  activateCurrentElement() {
    const element = this.getCurrentElement();
    if (!element) return;

    // Simulate click or trigger default action
    if (element.tagName === 'BUTTON' || element.tagName === 'A') {
      element.click();
    } else if (element.tagName === 'INPUT') {
      const input = element as HTMLInputElement;
      if (input.type === 'checkbox' || input.type === 'radio') {
        element.click();
      } else if (this.isTextInput(input.type)) {
        // Open Steam keyboard for text inputs
        this.openSteamKeyboard(input);
      } else {
        element.focus();
      }
    } else if (element.tagName === 'TEXTAREA') {
      // Open Steam keyboard for textareas
      this.openSteamKeyboard(element as HTMLTextAreaElement);
    }
  }

  /**
   * Check if input type is a text-based input
   */
  isTextInput(type: string): boolean {
    const textTypes = [
      'text',
      'password',
      'email',
      'search',
      'url',
      'tel',
      'number',
    ];
    return textTypes.includes(type);
  }

  /**
   * Open the Steam keyboard for text input.
   * The Steam overlay keyboard injects text directly into the focused element.
   */
  async openSteamKeyboard(
    element: HTMLInputElement | HTMLTextAreaElement
  ): Promise<void> {
    // Focus the element first - Steam keyboard will inject text here
    element.focus();

    // Get input properties for the keyboard
    const previousText = element.value || '';
    const title =
      element.placeholder ||
      element.getAttribute('aria-label') ||
      element.name ||
      'Enter text';
    const maxChars =
      element instanceof HTMLInputElement
        ? element.maxLength > 0
          ? element.maxLength
          : 500
        : 2000;

    try {
      // Try to open Steam keyboard overlay
      // The keyboard injects text directly into the focused input
      const opened = await window.electronAPI.app.openSteamKeyboard({
        previousText,
        title,
        maxChars,
      });

      if (!opened) {
        // Steam keyboard not available (not on Steam Deck/Big Picture)
        // Element is already focused for manual input
        console.log('Steam keyboard not available, element focused for input');
      }
    } catch (error) {
      // Steam keyboard not available, element is already focused
      console.log('Steam keyboard error, focusing input instead:', error);
    }
  }

  goBack() {
    // Implement your back navigation logic
    window.history.back();
  }

  destroy() {
    clearInterval(this.gamepadLoop as NodeJS.Timeout);
    document.removeEventListener(
      'focusin',
      this.handleExternalFocus.bind(this)
    );
  }
}
