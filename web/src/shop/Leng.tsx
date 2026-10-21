import styles from "./shop.module.css";

// Leng behind his counter: placeholder art drawn for Commander Duels (v0.4.0), until the owner's
// own. Plain shapes only; recorded in docs/asset-provenance.csv.

const PACKS = [
  ["#7a2f2a", "#d9a35a"],
  ["#2c4f6e", "#9cc3d9"],
  ["#3f5e35", "#c4d48a"],
  ["#5b3a6e", "#d0a8e0"],
  ["#6e5a2a", "#f0d58a"],
  ["#2a5d58", "#9adbcf"],
];

function Shelf({ y }: { y: number }) {
  return (
    <g>
      {Array.from({ length: 11 }, (_, index) => {
        const [body, band] = PACKS[(index + y) % PACKS.length];
        const x = 18 + index * 27 + ((index * 7 + y) % 5);
        const height = 30 + ((index * 13 + y) % 9);
        return (
          <g
            key={index}
            transform={`rotate(${((index * 5 + y) % 7) - 3} ${x + 9} ${y})`}
          >
            <rect
              x={x}
              y={y - height}
              width={19}
              height={height}
              rx={2}
              fill={body}
            />
            <rect
              x={x}
              y={y - height + 7}
              width={19}
              height={5}
              fill={band}
              opacity={0.85}
            />
            <path
              d={`M${x} ${y - height} l3 -3 h13 l3 3`}
              fill={body}
              stroke="#00000040"
              strokeWidth={1}
            />
          </g>
        );
      })}
      <rect x={8} y={y} width={304} height={7} rx={1} fill="#4a3322" />
      <rect x={8} y={y + 7} width={304} height={3} fill="#2a1c12" />
    </g>
  );
}

export function Leng({ className }: { className?: string }) {
  return (
    <svg
      className={`${styles.leng} ${className ?? ""}`}
      viewBox="0 0 320 240"
      role="img"
      aria-label="Leng, an old shopkeeper in a green robe and spectacles, behind his wooden counter, with shelves of booster packs behind him"
    >
      <defs>
        <radialGradient id="leng-lamp" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffd98a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffd98a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="leng-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#21190f" />
          <stop offset="1" stopColor="#30251a" />
        </linearGradient>
        <linearGradient id="leng-counter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7a5333" />
          <stop offset="1" stopColor="#4a301c" />
        </linearGradient>
        <linearGradient id="leng-robe" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3d6a50" />
          <stop offset="1" stopColor="#24402f" />
        </linearGradient>
      </defs>
      <rect width="320" height="240" fill="url(#leng-wall)" />
      <Shelf y={58} />
      <Shelf y={112} />
      {/* The lantern. */}
      <g className={styles.lantern}>
        <circle cx="262" cy="34" r="46" fill="url(#leng-lamp)" />
        <line
          x1="262"
          y1="0"
          x2="262"
          y2="20"
          stroke="#8a6a3a"
          strokeWidth="2"
        />
        <rect
          x="253"
          y="20"
          width="18"
          height="24"
          rx="4"
          fill="#f5c76a"
          stroke="#8a6a3a"
          strokeWidth="2"
        />
      </g>
      {/* Leng. */}
      <g>
        <path
          d="M108 238 C112 168 132 146 160 146 C188 146 208 168 212 238 Z"
          fill="url(#leng-robe)"
        />
        <path d="M150 150 L160 196 L170 150 Z" fill="#c9a24a" opacity="0.9" />
        <path
          d="M128 92 C126 56 194 56 192 92 L186 102 L134 102 Z"
          fill="#2f5a43"
        />
        <rect x="128" y="94" width="64" height="8" rx="3" fill="#c9a24a" />
        <ellipse cx="160" cy="118" rx="24" ry="26" fill="#d9b38c" />
        <path
          d="M138 124 C140 162 180 162 182 124 C176 136 144 136 138 124 Z"
          fill="#ece6da"
        />
        <path
          d="M148 132 C154 128 166 128 172 132"
          stroke="#b9ae9c"
          strokeWidth="2"
          fill="none"
        />
        <circle
          cx="151"
          cy="114"
          r="6.5"
          fill="#ffffff22"
          stroke="#e7d39a"
          strokeWidth="1.8"
        />
        <circle
          cx="169"
          cy="114"
          r="6.5"
          fill="#ffffff22"
          stroke="#e7d39a"
          strokeWidth="1.8"
        />
        <line
          x1="157.5"
          y1="114"
          x2="162.5"
          y2="114"
          stroke="#e7d39a"
          strokeWidth="1.6"
        />
        <circle cx="151" cy="115" r="1.8" fill="#2b2118" />
        <circle cx="169" cy="115" r="1.8" fill="#2b2118" />
        <path
          d="M145 106 l10 -2 M175 106 l-10 -2"
          stroke="#ece6da"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </g>
      {/* The counter, his hands on it, a pack and a candle. */}
      <rect x="0" y="186" width="320" height="54" fill="url(#leng-counter)" />
      <rect x="0" y="180" width="320" height="9" fill="#8d6440" />
      <rect x="0" y="189" width="320" height="2" fill="#2a1c12" opacity="0.6" />
      <path d="M140 196 h40 l-6 10 h-28 Z" fill="#c9a24a" opacity="0.4" />
      <ellipse cx="140" cy="182" rx="12" ry="6" fill="#d9b38c" />
      <ellipse cx="180" cy="182" rx="12" ry="6" fill="#d9b38c" />
      <g transform="rotate(-8 92 170)">
        <rect x="82" y="152" width="22" height="30" rx="2" fill="#7a2f2a" />
        <rect x="82" y="159" width="22" height="5" fill="#d9a35a" />
      </g>
      <rect x="228" y="160" width="10" height="22" rx="2" fill="#efe3c4" />
      <path
        className={styles.flame}
        d="M233 148 C238 154 237 160 233 161 C229 160 228 154 233 148 Z"
        fill="#ffc85a"
      />
    </svg>
  );
}
