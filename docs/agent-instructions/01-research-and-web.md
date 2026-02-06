# Research and Web Usage

## Internet is First-Class

The internet is not optional. Agents must use web search to find current best practices before coding. Do not rely solely on training data for:

- Library APIs and versions
- Security advisories
- Platform-specific behavior
- Current recommended patterns

## When to Research

### Before Adding Dependencies

- Search for the package's current status (maintained? deprecated?)
- Check npm download trends and last publish date
- Look for known vulnerabilities (`npm audit` equivalent)
- Verify compatibility with Node.js 16+

### Before Implementing Patterns

- Search for "[pattern] best practices [year]"
- Look for cross-platform gotchas (especially Windows + Linux)
- Check if the framework/library has built-in solutions

### Before Making Architectural Decisions

- Search for alternatives and their tradeoffs
- Find 3+ sources before committing to an approach
- Document sources in the ADR

## Validation Protocol

1. **Version Check**: Before using any API, search for its current documentation
2. **CVE Check**: Before adding dependencies, search for known vulnerabilities
3. **Platform Check**: Before using OS-specific features, verify cross-platform support
4. **Deprecation Check**: Before using any pattern, verify it's not deprecated

## Information Saturation

Research until you reach information saturation — the point where new searches return the same information you already have. Only then proceed to implementation.

## Citation in ADRs

When writing Architecture Decision Records, cite external sources:
- Link to documentation pages
- Reference Stack Overflow answers or GitHub issues
- Note the date of the research (information has a shelf life)
