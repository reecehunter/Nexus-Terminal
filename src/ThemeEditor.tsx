import { useEffect, useState } from 'react';
import {
  colorLabels,
  deleteCustomTheme,
  defaultTheme,
  loadCustomThemes,
  parseTheme,
  saveCustomTheme,
  themePresets,
  useTheme,
  type Theme,
  type ThemeColor,
} from './theme';

export function ThemeEditor() {
  const { theme, updateTheme } = useTheme();
  const [customThemes, setCustomThemes] = useState(loadCustomThemes);
  const [error, setError] = useState('');
  const [json, setJson] = useState('');
  const [themeName, setThemeName] = useState(theme.name);
  useEffect(() => setThemeName(theme.name), [theme.name]);
  function apply(next: Theme) {
    try {
      updateTheme(next);
      setError('');
    } catch (error) {
      setError(String(error));
    }
  }
  function commitThemeName() {
    if (!themeName.trim()) {
      setThemeName(theme.name);
      setError('Theme name must be 1–80 characters.');
      return;
    }
    apply({ ...theme, name: themeName });
  }
  return (
    <section className="theme-settings" aria-label="Appearance">
      <div className="hotkey-heading">
        <h3>Appearance</h3>
        <button className="quiet-button" onClick={() => apply(defaultTheme)}>
          Reset theme
        </button>
      </div>
      <p className="field-help">Changes apply immediately and save automatically on this device.</p>
      <h4>Built-in</h4>
      <div className="theme-presets" aria-label="Built-in themes">
        {themePresets.map((preset) => (
          <button
            key={preset.name}
            className="theme-preset"
            onClick={() => apply(preset)}
            aria-pressed={theme.name === preset.name}
          >
            <span
              className="theme-swatch"
              style={{ background: preset.colors.background, color: preset.colors.accent }}
            >
              Aa
            </span>
            {preset.name}
          </button>
        ))}
      </div>
      <div className="custom-theme-heading">
        <h4>Custom</h4>
        <button
          className="quiet-button"
          onClick={() => {
            try {
              setCustomThemes(saveCustomTheme(theme));
              setError('');
            } catch (error) {
              setError(String(error));
            }
          }}
        >
          Save current theme
        </button>
      </div>
      {customThemes.length > 0 ? (
        <div className="theme-presets" aria-label="Custom themes">
          {customThemes.map((preset) => (
            <div className="theme-preset custom-theme-preset" key={preset.name}>
              <button
                className="theme-preset-apply"
                onClick={() => apply(preset)}
                aria-pressed={theme.name === preset.name}
                aria-label={`Apply custom theme ${preset.name}`}
              >
                <span
                  className="theme-swatch"
                  style={{ background: preset.colors.background, color: preset.colors.accent }}
                >
                  Aa
                </span>
                {preset.name}
              </button>
              <button
                className="quiet-button"
                aria-label={`Delete custom theme ${preset.name}`}
                onClick={() => setCustomThemes(deleteCustomTheme(preset.name))}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="field-help">Save your current settings here for quick access later.</p>
      )}
      <div className="theme-fields">
        <label>
          Theme name
          <input
            value={themeName}
            maxLength={80}
            onChange={(event) => setThemeName(event.target.value)}
            onBlur={commitThemeName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        </label>
        <label>
          Terminal font
          <input
            value={theme.fontFamily}
            onChange={(event) => apply({ ...theme, fontFamily: event.target.value })}
          />
        </label>
        <label>
          Font size
          <input
            type="range"
            min="10"
            max="28"
            value={theme.fontSize}
            onChange={(event) => apply({ ...theme, fontSize: Number(event.target.value) })}
          />
          <output>{theme.fontSize}px</output>
        </label>
        <label>
          Line height
          <input
            type="range"
            min="1"
            max="2"
            step="0.05"
            value={theme.lineHeight}
            onChange={(event) => apply({ ...theme, lineHeight: Number(event.target.value) })}
          />
          <output>{theme.lineHeight.toFixed(2)}</output>
        </label>
        <label>
          Cursor style
          <select
            value={theme.cursorStyle}
            onChange={(event) =>
              apply({ ...theme, cursorStyle: event.target.value as Theme['cursorStyle'] })
            }
          >
            {['bar', 'block', 'underline'].map((style) => (
              <option key={style}>{style}</option>
            ))}
          </select>
        </label>
        <label className="theme-checkbox">
          <input
            type="checkbox"
            checked={theme.cursorBlink}
            onChange={(event) => apply({ ...theme, cursorBlink: event.target.checked })}
          />
          Blink cursor
        </label>
      </div>
      <div
        className="theme-preview"
        style={{
          fontFamily: theme.fontFamily,
          fontSize: theme.fontSize,
          lineHeight: theme.lineHeight,
        }}
        aria-label="Theme preview"
      >
        <span style={{ color: theme.colors.promptUser }}>user</span>
        <span style={{ color: theme.colors.promptHost }}>@host</span>{' '}
        <span style={{ color: theme.colors.promptDirectory }}>~</span>{' '}
        <span style={{ color: theme.colors.promptSymbol }}>%</span>{' '}
        <span style={{ color: theme.colors.green }}>git</span> status{' '}
        <span style={{ color: theme.colors.blue }}>--short</span>
        <br />
        <span style={{ color: theme.colors.muted }}>On branch main</span>
        <br />
        {(['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as ThemeColor[]).map((color) => (
          <span key={color} style={{ color: theme.colors[color] }}>
            {' '}
            ●{' '}
          </span>
        ))}
        <span style={{ color: theme.colors.cursor }}>▏</span>
      </div>
      <details open>
        <summary>Prompt colors</summary>
        <p className="field-help">
          Colors apply to the standard zsh prompt. Custom prompt layouts are preserved. Open a new
          terminal session to enable prompt coloring.
        </p>
        <div className="theme-colors">
          {(['promptUser', 'promptHost', 'promptDirectory', 'promptSymbol'] as ThemeColor[]).map(
            (key) => (
              <label key={key}>
                {colorLabels[key]}
                <input
                  type="color"
                  aria-label={colorLabels[key]}
                  value={theme.colors[key]}
                  onChange={(event) =>
                    apply({ ...theme, colors: { ...theme.colors, [key]: event.target.value } })
                  }
                />
              </label>
            ),
          )}
        </div>
      </details>
      <details>
        <summary>Interface & terminal colors</summary>
        <p className="field-help">
          Command highlighting uses Green for commands, Red for unknown commands, Blue for options,
          Yellow for strings, Cyan for paths, and Magenta for operators and variables. Output colors
          are supplied by each command; tools without color support use Text. Open a new terminal
          session to enable shell highlighting. Existing shell highlighters are preserved.
        </p>
        <div className="theme-colors">
          {(Object.keys(colorLabels) as ThemeColor[])
            .filter((key) => !key.startsWith('prompt'))
            .map((key) => (
              <label key={key}>
                {colorLabels[key]}
                <input
                  type="color"
                  aria-label={colorLabels[key]}
                  value={theme.colors[key]}
                  onChange={(event) =>
                    apply({ ...theme, colors: { ...theme.colors, [key]: event.target.value } })
                  }
                />
              </label>
            ))}
        </div>
      </details>
      <details>
        <summary>Import / export theme JSON</summary>
        <p className="field-help">
          Export to copy your theme, or paste a complete theme below to import it.
        </p>
        <textarea
          aria-label="Theme JSON"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          spellCheck={false}
        />
        <div className="theme-presets">
          <button className="quiet-button" onClick={() => setJson(JSON.stringify(theme, null, 2))}>
            Export JSON
          </button>
          <button
            className="quiet-button"
            onClick={() => {
              try {
                apply(parseTheme(JSON.parse(json)));
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            Import JSON
          </button>
        </div>
      </details>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
