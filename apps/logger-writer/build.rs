// Compile the static lattik.logger.v1.Envelope proto into prost types at
// build time. The per-table payload proto is NOT compiled here — it's
// fetched from Schema Registry at runtime and decoded dynamically.

fn main() -> std::io::Result<()> {
    println!("cargo:rerun-if-changed=proto/lattik/logger/v1/envelope.proto");
    prost_build::Config::new()
        .compile_protos(
            &["proto/lattik/logger/v1/envelope.proto"],
            &["proto/"],
        )?;
    Ok(())
}
