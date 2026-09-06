//! Scratch: does a virtual DESTINATION show up in our own input list?
//! Not part of the product.
use midir::os::unix::VirtualInput;

fn main() {
    let list = |tag: &str| {
        let i = midir::MidiInput::new("probe-in").unwrap();
        let o = midir::MidiOutput::new("probe-out").unwrap();
        println!("--- {tag}");
        println!("  sources (MidiInput::ports):");
        for p in i.ports() { println!("    {}", i.port_name(&p).unwrap_or_default()); }
        println!("  destinations (MidiOutput::ports):");
        for p in o.ports() { println!("    {}", o.port_name(&p).unwrap_or_default()); }
    };
    list("before");
    let input = midir::MidiInput::new("LIGHT").unwrap();
    let _conn = input.create_virtual("LIGHT", |_, _, _| {}, ()).expect("virtual destination");
    std::thread::sleep(std::time::Duration::from_millis(300));
    list("after creating a virtual destination named LIGHT");
}
