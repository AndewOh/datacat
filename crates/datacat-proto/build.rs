// datacat-proto build.rs
//
// opentelemetry-proto crate를 직접 의존성으로 사용하므로
// 별도의 proto 컴파일이 필요 없다.
//
// 향후 자체 proto 파일(예: datacat 전용 RPC)이 추가되면
// tonic_build::compile_protos를 이 파일에서 호출한다.
//
// 예시:
// fn main() -> Result<(), Box<dyn std::error::Error>> {
//     tonic_build::compile_protos("proto/datacat.proto")?;
//     Ok(())
// }

fn main() {
    // proto 재컴파일 트리거 없음 — opentelemetry-proto 의존성 사용
}
