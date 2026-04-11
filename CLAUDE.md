# Astro Backend Project Guidelines

This document outlines the guidelines, workflow, and coding standards for the Astro backend project.

## Overview
The Astro backend is a Node.js/Express application that provides API endpoints for the Astro application. It uses Prisma as the ORM, Better-Auth for authentication, and includes web scraping capabilities with Playwright.

## Development Workflow

### Branching Strategy
- Use feature branches for all new work: `feature/description`
- Use bug fix branches: `bugfix/description`
- Use release branches for version releases: `release/vX.Y.Z`
- Hotfix branches for production issues: `hotfix/description`

### Pull Request Process
1. Create a feature branch from `main`
2. Make commits with descriptive messages
3. Push branch to remote
4. Open a pull request against `main`
5. Request review from at least one team member
6. Address review feedback
7. Squash and merge upon approval
8. Delete feature branch after merge

### Commit Message Convention
- Use imperative mood: "Add feature" not "Added feature"
- Format: `type(scope): description`
- Types: feat, fix, docs, style, refactor, perf, test, chore
- Example: `feat(auth): add login functionality`

## Coding Standards

### General Principles
- Write clear, readable code
- Prefer simplicity over cleverness
- Follow the principle of least astonishment
- DRY (Don't Repeat Yourself) but don't over-abstraction
- Comment why, not what

### JavaScript/Node.js Standards
- Use ES6+ syntax (arrow functions, destructuring, etc.)
- Use `const` and `let` instead of `var`
- Prefer template literals over string concatenation
- Handle promises properly with async/await
- Always handle errors in async functions
- Use meaningful variable and function names
- Keep functions small and focused (single responsibility principle)

### Formatting
- Use consistent indentation (2 spaces)
- Limit line length to 80-120 characters
- Use meaningful variable and function names
- Keep functions small and focused (single responsibility principle)
- Add JSDoc comments for public APIs and complex functions

### Error Handling
- Handle errors appropriately, don't ignore them
- Use consistent error handling patterns throughout the codebase
- Log errors with sufficient context for debugging
- Fail fast when encountering unrecoverable states
- In Express handlers, always pass errors to next()

### Testing
- Write tests for new functionality
- Maintain or improve test coverage
- Write unit tests that are fast, isolated, and repeatable
- Integration tests should test critical user flows
- Test both positive and negative cases

### Security
- Never commit secrets or credentials to the repository
- Validate and sanitize all user inputs
- Use environment variables for configuration
- Follow the principle of least privilege
- Regularly update dependencies
- Use helmet.js for security headers
- Implement rate limiting where appropriate

### Performance
- Consider performance implications of changes
- Avoid premature optimization but don't ignore obvious inefficiencies
- Profile and measure before optimizing
- Cache appropriately when beneficial
- Use database indexing effectively
- Minimize N+1 query problems

## Project Structure
```
src/
├── index.js              # Entry point
├── routes/               # API route handlers
│   ├── auth.js           # Authentication routes
│   ├── users.js          # User routes
│   └── ...               # Other route files
├── middleware/           # Custom middleware
├── controllers/          # Request controllers
├── services/             # Business logic
├── utils/                # Utility functions
├── prisma/               # Prisma schema and migrations
└── config/               # Configuration files
```

## Database Guidelines
- Use Prisma for all database interactions
- Keep schema migrations in version control
- Write efficient Prisma queries
- Use transactions for related operations
- Index frequently queried fields
- Follow Prisma naming conventions

## API Design
- Use RESTful principles where appropriate
- Version API endpoints when breaking changes are needed
- Use consistent response formats
- Implement proper HTTP status codes
- Validate request bodies with Zod
- Implement proper CORS policies

## Environment Variables
- Store sensitive configuration in .env file
- Never commit .env to version control
- Use descriptive names for environment variables
- Provide .env.example with required variables