use std::io::{self, Write};
use std::path::Path;
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
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
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

    let mut conversation: Vec<Message> = Vec::new();

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

        let resp = agent.chat(&conversation);

        conversation.push(Message {
            role: "assistant".to_string(),
            content: resp.content.clone(),
            tool_calls: resp.tool_calls.clone(),
            tool_call_id: None,
        });

        let mut results: Vec<Message> = Vec::new();
        if let Some(ref calls) = resp.tool_calls {
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

        if let Some(ref text) = resp.content {
            if !text.is_empty() {
                println!("\x1b[93mAgent\x1b[0m: {text}");
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
        "read_file" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or(serde_json::json!({}));
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            match fs::read_to_string(path) {
                Ok(s) => s,
                Err(e) => format!("error: {e}"),
            }
        }
        "list_files" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or(serde_json::json!({}));
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let entries = list_files_recursive(path);
            serde_json::to_string(&entries).unwrap_or_else(|_| "error".to_string())
        }
        "edit_file" => {
            let args: Value = serde_json::from_str(arguments).unwrap_or(serde_json::json!({}));
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let old_str = args.get("old_str").and_then(|v| v.as_str()).unwrap_or("");
            let new_str = args.get("new_str").and_then(|v| v.as_str()).unwrap_or("");
            edit_file(path, old_str, new_str)
        }
        _ => format!("unknown tool: {name}"),
    }
}

fn list_files_recursive(dir: &str) -> Vec<String> {
    let mut entries = Vec::new();
    let root = Path::new(dir);
    if !root.is_dir() {
        return entries;
    }
    list_dir(root, root, &mut entries);
    entries
}

fn list_dir(base: &Path, dir: &Path, entries: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if let Ok(rel) = path.strip_prefix(base) {
            let s = rel.to_string_lossy().to_string();
            if path.is_dir() {
                entries.push(s + "/");
                list_dir(base, &path, entries);
            } else {
                entries.push(s);
            }
        }
    }
}

fn edit_file(path: &str, old_str: &str, new_str: &str) -> String {
    if path.is_empty() || (old_str == new_str) {
        return "error: invalid parameters".to_string();
    }

    // create new file if old_str is empty and file doesn't exist
    if old_str.is_empty() {
        if let Ok(_) = fs::metadata(path) {
            return "error: file exists but old_str is empty".to_string();
        }
        // create parent dirs
        if let Some(p) = Path::new(path).parent() {
            let _ = fs::create_dir_all(p);
        }
        match fs::write(path, new_str) {
            Ok(_) => return format!("created {path}"),
            Err(e) => return format!("error: {e}"),
        }
    }

    let content = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => return format!("error: {e}"),
    };

    let replaced = content.replacen(old_str, new_str, 1);
    if replaced == content {
        return "error: old_str not found in file".to_string();
    }

    match fs::write(path, &replaced) {
        Ok(_) => "OK".to_string(),
        Err(e) => format!("error: {e}"),
    }
}

fn tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "read_file".to_string(),
                description: "Read the contents of a given relative file path. Use this when you want to see what's inside a file. Do not use this with directory names.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The relative path of a file in the working directory."
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "list_files".to_string(),
                description: "List files and directories at a given path. If no path is provided, lists files in the current directory.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Optional relative path to list files from. Defaults to current directory if not provided."
                        }
                    }
                }),
            },
        },
        ToolDef {
            r#type: "function".to_string(),
            function: FunctionDef {
                name: "edit_file".to_string(),
                description: "Make edits to a text file. Replaces old_str with new_str in the given file. old_str and new_str MUST be different from each other. If the file specified with path doesn't exist, it will be created.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The path to the file"
                        },
                        "old_str": {
                            "type": "string",
                            "description": "Text to search for - must match exactly and must only have one match exactly"
                        },
                        "new_str": {
                            "type": "string",
                            "description": "Text to replace old_str with"
                        }
                    },
                    "required": ["path", "old_str", "new_str"]
                }),
            },
        },
    ]
}

impl Agent {
    fn chat(&self, conversation: &[Message]) -> Message {
        let tools = tool_defs();
        let body = ChatRequest {
            model: self.model.clone(),
            messages: conversation.to_vec(),
            tools: Some(tools),
        };

        let response = ureq::post(&format!("{}/chat/completions", self.base_url))
            .set("Content-Type", "application/json")
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .send_json(&body);

        match response {
            Ok(r) => {
                let chat: ChatResponse = r.into_json().unwrap_or_else(|_| {
                    panic!("failed to parse response")
                });
                chat.choices.into_iter().next().unwrap().message
            }
            Err(e) => {
                eprintln!("API error: {e:?}");
                Message {
                    role: "assistant".to_string(),
                    content: Some(format!("error: {e:?}")),
                    tool_calls: None,
                    tool_call_id: None,
                }
            }
        }
    }
}
