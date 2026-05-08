---
description: "Use when editing or creating threat analysis markdown files, STRIDE threat models, or security assessment documents. Enforces consistent threat format."
applyTo: "**/threat-analysis.md"
---
# STRIDE Threat Analysis Format Rules

When writing or editing threat analysis files, ALWAYS use this exact format:

```markdown
### Threat: {Descriptive Title}
**STRIDE Category**: Spoofing|Tampering|Repudiation|Information Disclosure|Denial of Service|Elevation of Privilege
**Severity**: Critical|High|Medium|Low
**Component**: {exact/file/path.ext:line-number} OR {Architecture Component Name}
**Description**: {detailed vulnerability explanation}
**Impact**: {specific consequences and business impact}
**Mitigation**:
- First mitigation step
- Second mitigation step
- Third mitigation step

---
```

## Strict Rules
1. Always use `###` (three hashes) for threat headings — never `#` or `##`
2. Heading MUST start with `Threat:` followed by a descriptive title
3. Each field MUST be on its own line with exact bold formatting
4. STRIDE Category MUST be exactly one of: `Spoofing`, `Tampering`, `Repudiation`, `Information Disclosure`, `Denial of Service`, `Elevation of Privilege`
5. Severity MUST be exactly one of: `Critical`, `High`, `Medium`, `Low`
6. Mitigation MUST be a bullet list using `-` (dash) prefix — never numbered lists
7. Separate each threat block with `---` (three dashes) on its own line
8. NO code blocks wrapping the threat content
9. NO extra fields or modified field names — the report parser depends on this exact schema
