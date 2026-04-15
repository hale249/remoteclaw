---
name: test
description: Run tests and report results
trigger: /test
skip_preview: true
skip_commit: true
---

# Run Tests

Execute the project's test suite and report results.

## Steps

1. Detect the test framework from the project (check package.json, pom.xml, go.mod, etc.)
2. Run the appropriate test command
3. Report results: passed, failed, skipped
4. For failures: show the failing test name, expected vs actual, and a brief analysis

## Common test commands

- Node.js: `npm test` or `npx vitest`
- Java: `mvn test` or `./gradlew test`
- Go: `go test ./...`
- PHP: `php artisan test` or `./vendor/bin/phpunit`
- Python: `pytest` or `python -m unittest`
