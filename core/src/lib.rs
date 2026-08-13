// Always available (wasm-safe): the data model and profile machinery.
pub mod color;
pub mod cprofile;
pub mod defaults;
pub mod effects;
pub mod gdtf;
pub mod mvr;
pub mod profiles;
pub mod types;

// OS-bound engine internals (sockets, MIDI, filesystem, timers).
#[cfg(feature = "engine")]
pub mod apc;
#[cfg(feature = "engine")]
pub mod artnet;
#[cfg(feature = "engine")]
pub mod clock;
#[cfg(feature = "engine")]
pub mod engine;
#[cfg(feature = "engine")]
pub mod link;
#[cfg(feature = "engine")]
pub mod midi;
#[cfg(feature = "engine")]
pub mod osc;
#[cfg(feature = "engine")]
pub mod persist;
#[cfg(feature = "engine")]
pub mod renderer;
#[cfg(feature = "engine")]
pub mod sacn;
#[cfg(feature = "engine")]
pub mod server;
#[cfg(feature = "engine")]
pub mod state;
