use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
struct Message {
    role: String,
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ToolCall {
    id: String,
    r#type: String,
    function: ToolFunction,
}

#[derive(Clone, Serialize, Deserialize)]
struct ToolFunction {
    name: String,
    arguments: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ToolDef>>,
    stream: bool,
}

#[derive(Serialize)]
struct ToolDef {
    r#type: String,
    function: FunctionDef,
}

#[derive(Serialize)]
struct FunctionDef {
    name: String,
    description: String,
    parameters: Value,
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct StreamDelta {
    content: Option<String>,
    tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Deserialize)]
struct StreamToolCall {
    index: usize,
    id: Option<String>,
    function: Option<StreamToolFunction>,
}

#[derive(Deserialize)]
struct StreamToolFunction {
    name: Option<String>,
    arguments: Option<String>,
}

struct Agent {
    api_key: String,
    base_url: String,
    model: String,
}

fn read_line() -> Option<String> {
    let mut line = String::new();
    if io::stdin().read_line(&mut line).ok()? == 0 {
        return None;
    }
    Some(line.trim_end().to_string())
}

fn main() {
    let api_key = std::env::var("OPENAI_API_KEY")
        .or_else(|_| std::env::var("ANTHROPIC_API_KEY"))
        .expect("set OPENAI_API_KEY or ANTHROPIC_API_KEY env var");
    let base_url = std::env::var("OPENAI_BASE_URL")
        .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
    let model = std::env::var("MODEL").unwrap_or_else(|_| "gpt-4o".to_string());

    let agent = Agent {
        api_key,
        base_url,
        model,
    };

    let mut conversation: Vec<Message> = vec![Message {
        role: "system".to_string(),
        content: Some(
            "You are an expert coding assistant operating inside valance-agent coding harness. \
            The working directory is the user's project root.
            Guidelines: \
            - Be concise in your responses
            - Show file paths clearly when working with files"
            .to_string(),
        ),
        tool_calls: None,
        tool_call_id: None,
    }];

    eprintln!("\x1b[93mChat with agent (ctrl-c to quit)\x1b[0m");

    let mut read_user = true;
    loop {
        if read_user {
            eprint!("\x1b[94mYou\x1b[0m: ");
            io::stderr().flush().ok();
            let Some(input) = read_line() else { break };
            conversation.push(Message {
                role: "user".to_string(),
                content: Some(input),
                tool_calls: None,
                tool_call_id: None,
            });
        }

        let (content, tool_calls) = agent.chat_streaming(&conversation);

        if !content.is_empty() {
            println!();
        }

        conversation.push(Message {
            role: "assistant".to_string(),
            content: if content.is_empty() { None } else { Some(content.clone()) },
            tool_calls: tool_calls.clone(),
            tool_call_id: None,
        });

        let mut results: Vec<Message> = Vec::new();
        if let Some(ref calls) = tool_calls {
            for tc in calls {
                eprintln!("\x1b[92mtool\x1b[0m: {}({})", tc.function.name, tc.function.arguments);
                let result = execute_tool(&tc.function.name, &tc.function.arguments);
                results.push(Message {
                    role: "tool".to_string(),
                    content: Some(result),
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                });
            }
        }

        if results.is_empty() {
            read_user = true;
        } else {
            read_user = false;
            conversation.extend(results);
        }
    }
}

fn execute_tool(name: &str, arguments: &str) -> String {
    match name {
        "read" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or_default();
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(1).max(1);
            let limit = args.get("limit").and_then(|v| v.as_u64());
            read_file(path, offset, limit)
        }
        "bash" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or_default();
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let timeout = args.get("timeout").and_then(|v| v.as_u64());
            exec_bash(command, timeout)
        }
        "edit" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or_default();
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let edits = args.get("edits");
            edit_file(path, edits)
        }
        "write" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or_default();
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            write_file(path, content)
        }
        "ls" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or_default();
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let limit = args.get("limit").and_then(|v| v.as_u64());
            list_dir(path, limit)
        }
        "find" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or_default();
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let name = args.get("name").and_then(|v| v.as_str());
            let file_type = args.get("type").and_then(|v| v.as_str());
            let limit = args.get("limit").and_then(|v| v.as_u64());
            find_files(path, name, file_type, limit)
        }
        "grep" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or_default();
            let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let limit = args.get("limit").and_then(|v| v.as_u64());
            let max_context_lines = args.get("maxContextLines").and_then(|v| v.as_u64());
            let case_sensitive = args.get("caseSensitive").and_then(|v| v.as_bool());
            let regex = args.get("regex").and_then(|v| v.as_bool());
            grep_search(pattern, path, limit, max_context_lines, case_sensitive, regex)
        }
        _ => format!("unknown tool: {name}"),
    }
}

// ── truncation ──

const DEFAULT_MAX_LINES: usize = 2000;
const DEFAULT_MAX_BYTES: usize = 50 * 1024;
const GREP_MAX_LINE_LENGTH: usize = 500;

fn truncate_head(content: &str, offset: usize, limit: Option<u64>) -> String {
    let limit = limit.map(|l| l as usize).unwrap_or(DEFAULT_MAX_LINES);
    let line_limit = DEFAULT_MAX_LINES.min(limit);
    let mut lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    if offset > 1 {
        if offset > total_lines {
            return String::new();
        }
        lines = lines[(offset - 1)..].to_vec();
    }
    let truncated = lines.len() > line_limit || content.len() > DEFAULT_MAX_BYTES;
    let mut out = String::new();
    let mut byte_count = 0;
    for (i, line) in lines.iter().enumerate() {
        if i >= line_limit || byte_count >= DEFAULT_MAX_BYTES {
            let next_offset = offset + i;
            out.push_str(&format!(
                "\n[... result too long, omitted. offset={next_offset} to continue ...]\n"
            ));
            break;
        }
        out.push_str(line);
        out.push('\n');
        byte_count += line.len() + 1;
    }
    if truncated && byte_count < DEFAULT_MAX_BYTES && lines.len() <= line_limit {
        out.push_str(&format!(
            "\n[... result too long, omitted. offset={} to continue ...]\n",
            offset + lines.len()
        ));
    }
    out
}

fn truncate_tail(content: &str, max_lines_override: Option<u64>) -> (String, PathBuf) {
    let limit = max_lines_override
        .map(|l| l as usize)
        .unwrap_or(DEFAULT_MAX_LINES);
    let line_limit = DEFAULT_MAX_LINES.min(limit);
    let lines: Vec<&str> = content.lines().collect();
    let truncated = lines.len() > line_limit || content.len() > DEFAULT_MAX_BYTES;

    let tmp_path = std::env::temp_dir().join(format!("agent-output-{}.txt", std::process::id()));
    let _ = fs::write(&tmp_path, content);

    if !truncated {
        return (content.to_string(), tmp_path);
    }

    let tail: Vec<&str> = lines
        .iter()
        .rev()
        .take(line_limit)
        .rev()
        .copied()
        .collect();
    let mut out = tail.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&format!(
        "\n[output truncated: kept last {line_limit} lines. full output at {}]\n",
        tmp_path.display()
    ));
    (out, tmp_path)
}

// ── read ──

fn read_file(path: &str, offset: u64, limit: Option<u64>) -> String {
    if path.is_empty() {
        return "error: path required".to_string();
    }
    let content = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => return format!("error: {e}"),
    };
    truncate_head(&content, offset as usize, limit)
}

// ── bash ──

fn exec_bash(command: &str, timeout_ms: Option<u64>) -> String {
    if command.is_empty() {
        return "error: command required".to_string();
    }
    let mut cmd = Command::new("bash");
    cmd.args(["-c", command])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("error: failed to spawn: {e}"),
    };

    let timeout = timeout_ms.map(Duration::from_millis).unwrap_or(Duration::from_secs(120));
    let result = {
        let pid = child.id();
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {
                    if start.elapsed() > timeout {
                        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
                        break Err("timeout");
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_e) => break Err("wait error"),
            }
        }
    };

    let mut output = String::new();
    if let Some(mut p) = child.stdout.take() {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut p, &mut buf).ok();
        output.push_str(&buf);
    }
    if let Some(mut p) = child.stderr.take() {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut p, &mut buf).ok();
        if !buf.is_empty() {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str("[stderr]\n");
            output.push_str(&buf);
        }
    }

    match result {
        Err("timeout") => {
            let (tail, path) = truncate_tail(&output, None);
            format!("[command timed out after {}ms]\n{tail}\n[full output: {}]", timeout.as_millis(), path.display())
        }
        Err(_) => format!("error: {result:?}"),
        Ok(status) => {
            let mut preamble = String::new();
            if !status.success() {
                preamble.push_str(&format!("[exit code: {}]\n", status.code().unwrap_or(-1)));
            }
            let (tail, _path) = truncate_tail(&output, None);
            format!("{preamble}{tail}")
        }
    }
}

// ── edit ──

fn edit_file(path: &str, edits: Option<&Value>) -> String {
    let edits = match edits.and_then(|v| v.as_array()) {
        Some(arr) if !arr.is_empty() => arr,
        _ => return "error: edits array required (non-empty)".to_string(),
    };

    if path.is_empty() {
        return "error: path required".to_string();
    }

    let mut content = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => return format!("error: {e}"),
    };

    for (i, edit) in edits.iter().enumerate() {
        let old_text = edit.get("oldText").and_then(|v| v.as_str()).unwrap_or("");
        let new_text = edit.get("newText").and_then(|v| v.as_str()).unwrap_or("");
        if old_text == new_text {
            continue;
        }
        let Some(pos) = content.find(old_text) else {
            return format!("error: edit {i}: oldText not found in file");
        };
        content.replace_range(pos..pos + old_text.len(), new_text);
    }

    match fs::write(path, &content) {
        Ok(_) => "OK".to_string(),
        Err(e) => format!("error: {e}"),
    }
}

// ── write ──

fn write_file(path: &str, content: &str) -> String {
    if path.is_empty() {
        return "error: path required".to_string();
    }
    if let Some(p) = Path::new(path).parent() {
        let _ = fs::create_dir_all(p);
    }
    match fs::write(path, content) {
        Ok(_) => format!("wrote {path}"),
        Err(e) => format!("error: {e}"),
    }
}

// ── ls ──

fn list_dir(path: &str, limit: Option<u64>) -> String {
    let limit = limit.map(|l| l as usize).unwrap_or(DEFAULT_MAX_LINES);
    let mut entries: Vec<String> = Vec::new();
    let Ok(rd) = fs::read_dir(path) else {
        return format!("error: cannot read directory {path}");
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            entries.push(name + "/");
        } else {
            entries.push(name);
        }
    }
    entries.sort();
    let total = entries.len();
    let truncated = total > limit;
    if truncated {
        entries.truncate(limit);
    }
    let mut out = entries.join("\n");
    if truncated {
        out.push_str(&format!(
            "\n\n[... truncated: showing {limit} of {total} entries]"
        ));
    }
    let bytes = out.len();
    if bytes > DEFAULT_MAX_BYTES {
        let cutoff = out
            .char_indices()
            .take_while(|(i, _)| *i < DEFAULT_MAX_BYTES)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(DEFAULT_MAX_BYTES);
        out.truncate(cutoff);
        out.push_str(&format!(
            "\n\n[... truncated: output exceeded {} bytes]",
            DEFAULT_MAX_BYTES
        ));
    }
    out
}

// ── find ──

fn find_files(path: &str, name: Option<&str>, file_type: Option<&str>, limit: Option<u64>) -> String {
    let limit = limit.map(|l| l as usize).unwrap_or(DEFAULT_MAX_LINES);
    let mut results = Vec::new();

    if try_fd(path, name, file_type, limit, &mut results) {
        return results.join("\n");
    }

    let name_pattern = name.unwrap_or("");
    find_fallback(path, name_pattern, file_type, limit, &mut results);
    let total = results.len();
    if total > limit {
        results.truncate(limit);
    }
    let mut out = results.join("\n");
    if total > limit {
        out.push_str(&format!("\n[... truncated: {total} matches, showing first {limit}]"));
    }
    out
}

fn try_fd(path: &str, name: Option<&str>, file_type: Option<&str>, limit: usize, results: &mut Vec<String>) -> bool {
    let mut cmd = Command::new("fd");
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(n) = name {
        cmd.arg(n);
    }
    if let Some(ft) = file_type {
        cmd.arg(match ft {
            "f" => "--type=file",
            "d" => "--type=directory",
            _ => "",
        });
    }
    cmd.arg(".").current_dir(path);

    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout);
            for line in s.lines() {
                if results.len() >= limit {
                    break;
                }
                let p = Path::new(line);
                let mut entry = line.to_string();
                if p.is_dir() {
                    entry.push('/');
                }
                results.push(entry);
            }
            return true;
        }
    }
    false
}

fn find_fallback(path: &str, name: &str, file_type: Option<&str>, limit: usize, results: &mut Vec<String>) {
    let mut cmd = Command::new("find");
    cmd.arg(path).stdout(Stdio::piped()).stderr(Stdio::null());

    if !name.is_empty() {
        cmd.arg("-name").arg(name);
    }
    if let Some(ft) = file_type {
        cmd.arg("-type").arg(ft);
    }

    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout);
            for line in s.lines() {
                if results.len() >= limit {
                    break;
                }
                let p = Path::new(line);
                let mut entry = line.to_string();
                if p.is_dir() {
                    entry.push('/');
                }
                results.push(entry);
            }
        }
    }
}

// ── grep ──

fn grep_search(
    pattern: &str, path: &str, limit: Option<u64>, max_context_lines: Option<u64>,
    case_sensitive: Option<bool>, regex: Option<bool>,
) -> String {
    if pattern.is_empty() {
        return "error: pattern required".to_string();
    }
    let limit = limit.map(|l| l as usize).unwrap_or(DEFAULT_MAX_LINES);
    let ctx = max_context_lines.map(|l| l as usize).unwrap_or(0);
    let mut results = Vec::new();

    if try_rg(pattern, path, limit, ctx, case_sensitive, regex, &mut results) {
        return results.join("\n");
    }

    grep_fallback(pattern, path, limit, ctx, case_sensitive, regex, &mut results);
    let total = results.len();
    if total > limit {
        results.truncate(limit);
    }
    let mut out = results.join("\n");
    if total > limit {
        out.push_str(&format!("\n[... truncated: {total} matches, showing first {limit}]"));
    }
    out
}

fn try_rg(
    pattern: &str, path: &str, limit: usize, ctx: usize,
    case_sensitive: Option<bool>, regex: Option<bool>, results: &mut Vec<String>,
) -> bool {
    let mut cmd = Command::new("rg");
    cmd.arg("--no-heading").arg("--color=never").stdout(Stdio::piped()).stderr(Stdio::null());

    if !regex.unwrap_or(true) {
        cmd.arg("--fixed-strings");
    }
    if !case_sensitive.unwrap_or(false) {
        cmd.arg("--ignore-case");
    }
    if ctx > 0 {
        cmd.arg("--context").arg(ctx.to_string());
    }

    cmd.arg("--").arg(pattern).arg(path);

    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout);
            for line in s.lines() {
                if results.len() >= limit {
                    break;
                }
                results.push(truncate_line(line, GREP_MAX_LINE_LENGTH));
            }
            return true;
        } else if output.status.code() == Some(1) {
            results.push("no matches found".to_string());
            return true;
        }
    }
    false
}

fn grep_fallback(
    pattern: &str, path: &str, limit: usize, ctx: usize,
    case_sensitive: Option<bool>, regex: Option<bool>, results: &mut Vec<String>,
) {
    let mut cmd = Command::new("grep");
    cmd.arg("-r").arg("-n").arg("-H").stdout(Stdio::piped()).stderr(Stdio::null());

    if !case_sensitive.unwrap_or(false) {
        cmd.arg("-i");
    }
    if regex.unwrap_or(true) {
        cmd.arg("-E");
    }
    if ctx > 0 {
        cmd.arg("-C").arg(ctx.to_string());
    }

    cmd.arg("--").arg(pattern).arg(path);

    if let Ok(output) = cmd.output() {
        let s = String::from_utf8_lossy(&output.stdout);
        for line in s.lines() {
            if results.len() >= limit {
                break;
            }
            results.push(truncate_line(line, GREP_MAX_LINE_LENGTH));
        }
    }
}

fn truncate_line(line: &str, max_len: usize) -> String {
    if line.len() <= max_len {
        line.to_string()
    } else {
        format!("{}...", &line[..max_len])
    }
}

fn tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "read".to_string(),
                description: "Read a file from the local filesystem. You can access any file directly.\n\nUsage:\n- You can optionally specify an offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing offset and limit.\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- If you read a file that exists but has empty contents you will receive 'File is empty.'.\n- You might also receive IDE diagnostic information (errors, warnings, hints) from linters and language servers.\n- If the file does not exist, you will receive an error message. DO NOT attempt to read the same non-existent file again.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The path to the file to read (relative or absolute)."
                        },
                        "offset": {
                            "type": "integer",
                            "description": "Line offset to start reading from (default: 1). 1-indexed."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of lines to read (default: 2000)."
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "bash".to_string(),
                description: "Execute a bash command. Returns the command output, auto-truncated to last 2000 lines.\n- The full output is always saved to a temp file for subsequent reading.\n- Use this for running build commands, tests, git operations, or any other shell command.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The bash command to execute (passed to `bash -c`)."
                        },
                        "timeout": {
                            "type": "integer",
                            "description": "Timeout in milliseconds (default: 120000). Command is killed after timeout expires."
                        }
                    },
                    "required": ["command"]
                }),
            },
        },
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "edit".to_string(),
                description: "Edit a single file using exact text replacements. This is the most precise way to edit files.\n\nUsage:\n- The `edits` array contains objects with `oldText` and `newText`.\n- Each edit replaces the first occurrence of `oldText` in the current file content with `newText`.\n- All edits are applied sequentially to the same file snapshot.\n- oldText and newText can be different lengths.\n- oldText must be unique within the file (only the first occurrence is replaced).".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The path to the file to edit."
                        },
                        "edits": {
                            "type": "array",
                            "description": "Array of edit operations to apply sequentially.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "oldText": {
                                        "type": "string",
                                        "description": "Exact text to find and replace."
                                    },
                                    "newText": {
                                        "type": "string",
                                        "description": "Text to replace oldText with."
                                    }
                                },
                                "required": ["oldText", "newText"]
                            }
                        }
                    },
                    "required": ["path", "edits"]
                }),
            },
        },
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "write".to_string(),
                description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.\n\nUsage:\n- Use this to create new files.\n- To edit existing files, prefer the `edit` tool for precision.\n- The file path must be absolute or relative to the working directory.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The path to the file to write."
                        },
                        "content": {
                            "type": "string",
                            "description": "The content to write to the file."
                        }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "ls".to_string(),
                description: "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output truncated to 2000 entries or 50KB (whichever is hit first).".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to list (defaults to current directory if not provided)."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of entries to return (default: 2000)."
                        }
                    },
                    "required": []
                }),
            },
        },
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "find".to_string(),
                description: "Find files or directories by name pattern. Uses `fd` if available, otherwise falls back to `find`.\n- Returns matching file and directory paths, sorted.\n- Directories are suffixed with '/'.\n- Results truncated if there are too many matches.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Directory to search in (default: current directory)."
                        },
                        "name": {
                            "type": "string",
                            "description": "Name or glob pattern to search for (e.g. '*.rs', 'main')."
                        },
                        "type": {
                            "type": "string",
                            "enum": ["f", "d"],
                            "description": "Filter by type: 'f' for files, 'd' for directories."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of results (default: 2000)."
                        }
                    },
                    "required": []
                }),
            },
        },
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "grep".to_string(),
                description: "Search for a pattern in files. Uses `rg` (ripgrep) if available, otherwise falls back to `grep -r`.\n- Returns matching lines with file path and line number.\n- Lines longer than 500 characters are truncated.\n- Results truncated to limit (default: 2000 matches).".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "The pattern to search for."
                        },
                        "path": {
                            "type": "string",
                            "description": "Directory or file path to search in (default: current directory)."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of matches to return (default: 2000)."
                        },
                        "maxContextLines": {
                            "type": "integer",
                            "description": "Number of context lines to show around each match (default: 0)."
                        },
                        "caseSensitive": {
                            "type": "boolean",
                            "description": "Whether the search is case-sensitive (default: false)."
                        },
                        "regex": {
                            "type": "boolean",
                            "description": "Whether pattern is a regex (default: true). Set to false for literal string search."
                        }
                    },
                    "required": ["pattern"]
                }),
            },
        },
    ]
}

impl Agent {
    fn chat_streaming(&self, conversation: &[Message]) -> (String, Option<Vec<ToolCall>>) {
        let tools = tool_defs();
        let body = ChatRequest {
            model: self.model.clone(),
            messages: conversation.to_vec(),
            tools: Some(tools),
            stream: true,
        };

        let response = ureq::post(&format!("{}/chat/completions", self.base_url))
            .set("Content-Type", "application/json")
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .send_json(&body);

        let mut reader = match response {
            Ok(r) => {
                if r.status() >= 400 {
                    let err: serde_json::Value = r.into_json().unwrap_or_default();
                    let msg = err.pointer("/error/message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown error");
                    return (format!("error: {msg}"), None);
                }
                io::BufReader::new(r.into_reader())
            }
            Err(e) => {
                eprintln!("API error: {e:?}");
                return (format!("error: {e:?}"), None);
            }
        };

        let mut content = String::new();
        let mut tool_deltas: Vec<(Option<String>, Option<String>, String)> = Vec::new();

        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).unwrap_or(0);
            if n == 0 {
                break;
            }
            let trimmed = line.trim_end();
            if !trimmed.starts_with("data: ") {
                continue;
            }
            let data = trimmed.trim_start_matches("data: ");
            if data == "[DONE]" {
                break;
            }
            let chunk: StreamChunk = match serde_json::from_str(data) {
                Ok(c) => c,
                Err(_) => continue,
            };
            for choice in chunk.choices {
                if choice.finish_reason.is_some() {
                    break;
                }
                if let Some(c) = choice.delta.content {
                    if content.is_empty() {
                        eprint!("\x1b[93mAgent\x1b[0m: ");
                        io::stderr().flush().ok();
                    }
                    print!("{c}");
                    io::stdout().flush().ok();
                    content.push_str(&c);
                }
                if let Some(calls) = choice.delta.tool_calls {
                    for tc in calls {
                        if tool_deltas.len() <= tc.index {
                            tool_deltas.resize(tc.index + 1, (None, None, String::new()));
                        }
                        let entry = &mut tool_deltas[tc.index];
                        if let Some(id) = tc.id {
                            entry.0 = Some(id);
                        }
                        if let Some(fn_) = tc.function {
                            if let Some(name) = fn_.name {
                                entry.1 = Some(name);
                            }
                            if let Some(args) = fn_.arguments {
                                entry.2.push_str(&args);
                            }
                        }
                    }
                }
            }
        }

        let tool_calls = if tool_deltas.is_empty() {
            None
        } else {
            Some(
                tool_deltas
                    .into_iter()
                    .filter(|(id, name, args)| id.is_some() && name.is_some() && !args.is_empty())
                    .map(|(id, name, args)| ToolCall {
                        id: id.unwrap_or_default(),
                        r#type: "function".to_string(),
                        function: ToolFunction {
                            name: name.unwrap_or_default(),
                            arguments: args,
                        },
                    })
                    .collect(),
            )
        };

        (content, tool_calls)
    }
}
