use glossa_lib::ai::inline_defs;
use schemars::schema_for;
fn main() {
    let s = inline_defs(serde_json::to_value(schema_for!(glossa_lib::commands::TokensOut)).unwrap());
    println!("{}", serde_json::to_string(&s).unwrap());
}
