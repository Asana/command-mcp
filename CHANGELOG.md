# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial `0.1.0` release surface for discovering Command Teamspaces and schemas; reading, listing, searching, creating, and updating tickets; reading and adding comments; managing dependencies and Release memberships; extracting pull-request links from Asana data; and diagnosing credentials and Teamspace configuration with `doctor`.
- Stdio MCP transport, read-only tool discovery, bounded scans and deadlines, resumable asynchronous ticket initialization, authoritative post-write verification, stable error payloads, and credential redaction.
- Release memberships on full ticket views returned by ticket read, list, search, create, and update tools.
