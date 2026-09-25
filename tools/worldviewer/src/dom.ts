// Tiny DOM helpers for the worldviewer panel

type Props = Record<string, unknown> & { class?: string };
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined) continue;
        if (key === 'class') element.className = String(value);
        else if (key.startsWith('on') && typeof value === 'function') {
            element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (key in element) {
            (element as unknown as Record<string, unknown>)[key] = value;
        } else {
            element.setAttribute(key, String(value));
        }
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        element.append(child);
    }
    return element;
}

export function row(label: string, ...controls: Child[]): HTMLDivElement {
    return el('div', { class: 'row' }, el('label', {}, label), ...controls);
}

export function dropdown<T extends string>(value: T, options: readonly (T | readonly [T, string])[], onChange: (value: T) => void, disabled: readonly T[] = []): HTMLSelectElement {
    const element = el('select', { onchange: () => onChange(element.value as T) });
    for (const option of options) {
        const [key, text] = typeof option === 'string' ? [option, option] : option;
        element.append(el('option', { value: key, selected: key === value, disabled: disabled.includes(key) }, text));
    }
    return element;
}

export function numberInput(value: number | undefined, onChange: (value: number | null) => void, options: { step?: number; placeholder?: string } = {}): HTMLInputElement {
    const input = el('input', {
        type: 'number',
        step: String(options.step ?? 0.1),
        value: value === undefined ? '' : String(value),
        placeholder: options.placeholder ?? '',
        onchange: () => {
            const text = input.value.trim();
            if (text === '') onChange(null);
            else if (Number.isFinite(Number(text))) onChange(Number(text));
        }
    });
    return input;
}

export function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
    const input = el('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
    return el('label', {}, input, ` ${label}`);
}

export function download(name: string, data: BlobPart, type: string): void {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        // No clipboard permission (e.g. not focused, http on a LAN IP): the
        // old way through a selected text area
        const area = el('textarea', { value: text });
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        if (!ok) throw new Error('the browser refused to copy');
    }
}
