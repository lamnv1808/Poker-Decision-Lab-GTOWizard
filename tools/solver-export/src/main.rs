//! Offline generator for Poker Decision Lab: solves BTN-vs-BB single-raised-pot flops with
//! postflop-solver (AGPL-3.0, used only as a separate offline tool) and exports per-hand strategies
//! and action EVs at the first flop decisions. Output JSON is consumed by the app; no solver code ships.
//!
//! Usage: pdl-gto <flop e.g. Td9d6h> <out.json> [target exploitability % of pot] [stackBB]
use postflop_solver::*;
use serde_json::{json, Value};
use std::time::Instant;

const CHIPS_PER_BB: f64 = 20.0;

fn export_node(game: &mut PostFlopGame, name: &str) -> Value {
    game.cache_normalized_weights();
    let player = game.current_player();
    let cards = holes_to_strings(game.private_cards(player)).unwrap();
    let n = cards.len();
    let actions: Vec<String> = game.available_actions().iter().map(|a| format!("{:?}", a)).collect();
    let strat = game.strategy();
    let evs = game.expected_values_detail(player);
    let weights = game.normalized_weights(player).to_vec();
    let equity = game.equity(player);
    let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
    let mut hands = Vec::new();
    for i in 0..n {
        if weights[i] <= 0.0005 {
            continue;
        }
        let freq: Vec<f64> = (0..actions.len()).map(|a| r3(strat[a * n + i] as f64)).collect();
        let ev: Vec<f64> = (0..actions.len()).map(|a| r3(evs[a * n + i] as f64 / CHIPS_PER_BB)).collect();
        hands.push(json!({ "c": cards[i], "w": r3(weights[i] as f64), "eq": r3(equity[i] as f64), "f": freq, "ev": ev }));
    }
    json!({ "node": name, "player": if player == 0 { "OOP" } else { "IP" }, "actions": actions, "hands": hands })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flop_str = args.get(1).expect("flop like Td9d6h").clone();
    let out = args.get(2).cloned().unwrap_or_else(|| format!("{}.json", flop_str));
    let target_pct: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0.5);
    let stack_bb: f64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(40.0);

    // MTT spot: BTN opens 2.2BB, BB (who posted a 1BB big-blind ante) calls. Pot 5.9BB.
    let pot_bb = 5.9;
    let behind_bb = stack_bb - 2.2;
    let ip_range = "22+,A2s+,A2o+,K2s+,K7o+,Q4s+,Q9o+,J6s+,J9o+,T6s+,T9o,96s+,98o,85s+,75s+,64s+,54s";
    let oop_range = "JJ-22,AQs-A2s,AQo-A2o,K2s+,K5o+,Q2s+,Q8o+,J4s+,J8o+,T6s+,T8o+,96s+,97o+,85s+,87o,74s+,76o,63s+,53s+,43s";
    let card_config = CardConfig {
        range: [oop_range.parse().unwrap(), ip_range.parse().unwrap()],
        flop: flop_from_str(&flop_str).unwrap(),
        turn: NOT_DEALT,
        river: NOT_DEALT,
    };
    let flop_oop = BetSizeOptions::try_from(("33%", "3x")).unwrap();
    let flop_ip = BetSizeOptions::try_from(("33%, 75%", "3x")).unwrap();
    let turn = BetSizeOptions::try_from(("66%", "3x")).unwrap();
    let river = BetSizeOptions::try_from(("75%, a", "a")).unwrap();
    let tree_config = TreeConfig {
        initial_state: BoardState::Flop,
        starting_pot: (pot_bb * CHIPS_PER_BB) as i32,
        effective_stack: (behind_bb * CHIPS_PER_BB) as i32,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [flop_oop, flop_ip],
        turn_bet_sizes: [turn.clone(), turn],
        river_bet_sizes: [river.clone(), river],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 1.5,
        force_allin_threshold: 0.15,
        merging_threshold: 0.1,
    };
    let tree = ActionTree::new(tree_config).unwrap();
    let mut game = PostFlopGame::with_config(card_config, tree).unwrap();
    let (mem, memc) = game.memory_usage();
    eprintln!("{flop_str}: memory {:.2}GB (compressed {:.2}GB)", mem as f64 / 1e9, memc as f64 / 1e9);
    game.allocate_memory(true);
    let t = Instant::now();
    let pot = game.tree_config().starting_pot as f32;
    let expl = solve(&mut game, 3000, pot * target_pct / 100.0, false);
    let secs = t.elapsed().as_secs_f64();
    eprintln!("{flop_str}: exploitability {:.3}% pot in {:.1}s", 100.0 * expl / pot, secs);

    let mut nodes = vec![export_node(&mut game, "oop_root")];
    let check = game.available_actions().iter().position(|x| matches!(x, Action::Check)).unwrap();
    game.play(check);
    nodes.push(export_node(&mut game, "ip_vs_check"));
    let ip_actions = game.available_actions();
    for (idx, act) in ip_actions.iter().enumerate() {
        if let Action::Bet(_) = act {
            game.play(idx);
            let name = format!("oop_vs_{:?}", act).replace(['(', ')'], "").to_lowercase();
            nodes.push(export_node(&mut game, &name));
            game.back_to_root();
            game.play(check);
        }
    }
    let out_json = json!({
        "flop": flop_str,
        "chipsPerBB": CHIPS_PER_BB,
        "potBB": pot_bb,
        "stackBB": stack_bb,
        "ranges": { "oop": oop_range, "ip": ip_range },
        "exploitabilityPctPot": ((100.0 * expl / pot) as f64 * 1000.0).round() / 1000.0,
        "solveSeconds": (secs * 10.0).round() / 10.0,
        "solver": "postflop-solver 0.1.0 (b-inary), discounted CFR",
        "tree": "flop: OOP bet 33% / IP bet 33%, 75%, raises 3x; turn: 66%, raise 3x; river: 75% or all-in, raise all-in",
        "nodes": nodes,
    });
    std::fs::write(&out, serde_json::to_string(&out_json).unwrap()).unwrap();
}
