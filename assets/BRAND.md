# EyeCX Brand Guidelines

## Logo Concept

**"Eye"** = Screening, seeing history, visual inspection of domains
**"CX"** = Common Crawl (primary data source) + Customer Experience

The eye icon incorporates scan lines to represent automated data scanning and intelligence gathering.

---

## Logo Files

| File | Use Case |
|------|----------|
| `logo.svg` | Primary logo with tagline (dark backgrounds) |
| `logo-white.svg` | Monochrome white (overlays, dark photos) |
| `wordmark.svg` | Text only, no icon (tight spaces) |
| `icon.svg` | App icon, social profiles (512x512) |
| `favicon.svg` | Browser tab (32x32) |

---

## Colors

### Primary Palette

| Name | Hex | Use |
|------|-----|-----|
| Cyan | `#22d3ee` | Primary accent, CTAs, highlights |
| Purple | `#a78bfa` | Secondary accent, gradients |
| Cyan Dark | `#0891b2` | Hover states, depth |
| Purple Dark | `#7c3aed` | Hover states, depth |

### Background

| Name | Hex | Use |
|------|-----|-----|
| Black | `#0a0a0f` | Page background |
| Surface | `#12121a` | Cards, sections |
| Border | `#1e1e2e` | Dividers, outlines |

### Text

| Name | Hex | Use |
|------|-----|-----|
| Primary | `#e4e4e7` | Headings, body |
| Muted | `#71717a` | Secondary text, labels |

### Status

| Name | Hex | Use |
|------|-----|-----|
| Success | `#34d399` | Positive, online |
| Diamond | `#a78bfa` | Diamond tier |
| Gold | `#fbbf24` | Gold tier |
| Silver | `#94a3b8` | Silver tier |

---

## Typography

### Font Stack

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

### Weights

- **700** - Headings, logo
- **600** - Subheadings, buttons
- **500** - Body emphasis
- **400** - Body text

---

## Logo Usage

### Minimum Size

- Icon: 32px minimum
- Logo with text: 120px width minimum

### Clear Space

Maintain padding equal to the height of the "E" in "Eye" on all sides.

### Don'ts

- ❌ Don't rotate the logo
- ❌ Don't change the gradient colors
- ❌ Don't add effects (shadows, glows)
- ❌ Don't stretch or distort
- ❌ Don't place on busy backgrounds without contrast

---

## Gradient CSS

```css
/* Primary gradient */
background: linear-gradient(135deg, #22d3ee, #a78bfa);

/* Text gradient */
background: linear-gradient(135deg, #22d3ee, #a78bfa);
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
```

---

## Social Media Sizes

| Platform | Size | File |
|----------|------|------|
| Twitter/X Profile | 400x400 | icon.svg |
| Twitter Header | 1500x500 | Create from logo.svg |
| LinkedIn Profile | 400x400 | icon.svg |
| GitHub Avatar | 500x500 | icon.svg |
| Favicon | 32x32 | favicon.svg |
| Apple Touch | 180x180 | icon.svg |
| OG Image | 1200x630 | Create from logo.svg |

---

## Voice & Tone

### Keywords
- Automated
- Intelligence
- Discovery
- Precision
- Zero manual

### Taglines
- "Expired Domain Intelligence"
- "Find diamonds in expired domains"
- "Screen. Score. Acquire. Monetize."
- "Zero manual steps."

### Writing Style
- Technical but accessible
- Confident, not boastful
- Data-driven claims
- Short sentences
