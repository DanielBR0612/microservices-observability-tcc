"""Graficos comparativos do experimento de overhead (sem-otel x otel-10 x otel-100).

Uso: python observabilidade/graficos-experimento.py resultados-experimento/<pasta>
Grava os PNGs em resultados-experimento/<pasta>/graficos/.
"""
import sys, os
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, MultipleLocator

BASE = sys.argv[1]
OUT = os.path.join(BASE, "graficos")
os.makedirs(OUT, exist_ok=True)

# Paleta: linha de base neutra; amostragem como rampa ordinal de um so matiz (validada)
COR = {"sem-otel": "#a3a19a", "otel-10": "#86b6ef", "otel-100": "#1c5cab"}
NOME = {"sem-otel": "sem OTel", "otel-10": "OTel 10%", "otel-100": "OTel 100%"}
INK, INK2, MUTED, GRID, AXIS, SURF = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"

plt.rcParams.update({
    "figure.facecolor": SURF, "axes.facecolor": SURF, "savefig.facecolor": SURF,
    "font.size": 10, "text.color": INK, "axes.labelcolor": INK2,
    "xtick.color": MUTED, "ytick.color": INK2, "axes.edgecolor": AXIS,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.titlesize": 11, "axes.titleweight": "bold", "axes.titlelocation": "left",
})

def br(x, casas=1):
    return f"{x:.{casas}f}".replace(".", ",")

def grade(ax, eixo="x"):
    ax.grid(axis=eixo, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)

def legenda(fig, configs, y=0.005):
    h = [plt.Rectangle((0, 0), 1, 1, color=COR[c]) for c in configs]
    fig.legend(h, [NOME[c] for c in configs], loc="lower center", ncol=len(configs),
               frameon=False, bbox_to_anchor=(0.5, y))

def salvar(fig, nome):
    fig.savefig(os.path.join(OUT, nome), dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("ok", nome)

comp = pd.read_csv(os.path.join(BASE, "comparacao.csv"))
lat = pd.read_csv(os.path.join(BASE, "latencia.csv"))
rec = pd.read_csv(os.path.join(BASE, "recursos.csv"))

PROTOS = ["SOAP", "REST", "AMQP notificacao PIX", "AMQP notificacao TED", "gRPC", "TCP", "WebSocket (handshake)"]
ROTULO = {"AMQP notificacao PIX": "AMQP (PIX)", "AMQP notificacao TED": "AMQP (TED)",
          "WebSocket (handshake)": "WebSocket"}

def linha(serie, metrica):
    return comp[(comp.serie == serie) & (comp.metrica == metrica)].iloc[0]

# ------------------------------------------------------------- 1. overhead relativo p50 / p99
fig, axes = plt.subplots(1, 2, figsize=(11, 5.2), sharey=True)
desloc = {"p50": 0.4, "p99": 3}
axes[0].invert_yaxis()
for ax, met in zip(axes, ["p50", "p99"]):
    ys = range(len(PROTOS))
    for k, cfg in enumerate(["otel-10", "otel-100"]):
        vals, ps = [], []
        for p in PROTOS:
            r = linha(p, met)
            vals.append(r[f"overhead_{cfg}_pct"]); ps.append(r[f"p_{cfg}"])
        pos = [y + (k - 0.5) * 0.38 for y in ys]
        ax.barh(pos, vals, height=0.34, color=COR[cfg], edgecolor=SURF, linewidth=1)
        for y, v, pv in zip(pos, vals, ps):
            sig = pv <= 0.05
            txt = f"{'+' if v >= 0 else ''}{br(v)}%" + (" *" if sig else "  n.s.")
            ax.text(max(v, 0) + desloc[met], y, txt, va="center",
                    ha="left", fontsize=8.5,
                    color=INK if sig else MUTED, fontweight="bold" if sig else "normal")
    ax.axvline(0, color=AXIS, linewidth=1)
    ax.set_yticks(list(ys), [ROTULO.get(p, p) for p in PROTOS])
    grade(ax)
    ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x)}%"))
    ax.xaxis.set_major_locator(MultipleLocator(5 if met == "p50" else 20))
    lo, hi = ax.get_xlim(); ax.set_xlim(lo, hi * 1.3)
    ax.set_title(f"Latência {met}")
    ax.set_xlabel("overhead em relação a sem OTel")
fig.suptitle("Overhead relativo de latência por protocolo", x=0.01, ha="left", fontsize=13, fontweight="bold")
fig.text(0.01, 0.925, "Mediana de 6 repetições por configuração.  * p ≤ 0,05 (Mann-Whitney exato);  n.s. = não significativo",
         color=INK2, fontsize=9)
fig.tight_layout(rect=(0, 0.06, 1, 0.92))
legenda(fig, ["otel-10", "otel-100"])
salvar(fig, "01-overhead-relativo.png")

# ------------------------------------------------------------- 2. overhead absoluto (ms) na p50
fig, ax = plt.subplots(figsize=(9, 4.8))
ys = range(len(PROTOS))
for k, cfg in enumerate(["otel-10", "otel-100"]):
    vals = [linha(p, "p50")[f"{cfg}_mediana"] - linha(p, "p50")["sem-otel_mediana"] for p in PROTOS]
    pos = [y + (k - 0.5) * 0.38 for y in ys]
    ax.barh(pos, vals, height=0.34, color=COR[cfg], edgecolor=SURF, linewidth=1)
    for y, v in zip(pos, vals):
        ax.text(max(v, 0) + 0.03, y, f"{'+' if v >= 0 else ''}{br(v, 2)} ms", va="center",
                ha="left", fontsize=8.5, color=INK2)
ax.axvline(0, color=AXIS, linewidth=1)
ax.set_yticks(list(ys), [f"{ROTULO.get(p, p)}  (base {br(linha(p, 'p50')['sem-otel_mediana'])} ms)" for p in PROTOS])
ax.invert_yaxis()
grade(ax)
ax.set_xlim(-0.05, 1.9)
ax.xaxis.set_major_locator(MultipleLocator(0.5))
ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{br(x)} ms"))
ax.set_xlabel("latência p50 adicionada pela instrumentação")
fig.suptitle("Custo absoluto na mediana: até 1,5 ms em todos os protocolos", x=0.01, ha="left",
             fontsize=13, fontweight="bold")
fig.text(0.01, 0.905, "O mesmo custo pesa +0,4% no SOAP (135 ms) e +15% no TCP (2 ms)", color=INK2, fontsize=9)
fig.tight_layout(rect=(0, 0.07, 1, 0.9))
legenda(fig, ["otel-10", "otel-100"])
salvar(fig, "02-overhead-absoluto-p50.png")

# ------------------------------------------------------------- 3. p99 por repeticao (gRPC, TCP)
CFGS = ["sem-otel", "otel-10", "otel-100"]
fig, axes = plt.subplots(1, 2, figsize=(10, 4.4))
for ax, proto in zip(axes, ["gRPC", "TCP"]):
    for i, cfg in enumerate(CFGS):
        d = lat[(lat.config == cfg) & (lat.serie == proto)]
        xs = [i + (j - (len(d) - 1) / 2) * 0.07 for j in range(len(d))]
        ax.scatter(xs, d.p99, s=46, color=COR[cfg], edgecolor=SURF, linewidth=1.5, zorder=3)
        med = d.p99.median()
        ax.hlines(med, i - 0.3, i + 0.3, color=INK, linewidth=2, zorder=4)
        ax.text(i + 0.33, med, f"{br(med)} ms", va="center", fontsize=8.5, color=INK)
    ax.set_xticks(range(3), [NOME[c] for c in CFGS])
    ax.set_xlim(-0.5, 2.85)
    ax.set_ylim(0, None)
    grade(ax, "y")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{int(y)} ms"))
    ax.set_title(proto)
fig.suptitle("Latência p99 em cada repetição: os grupos não se sobrepõem", x=0.01, ha="left",
             fontsize=13, fontweight="bold")
fig.text(0.01, 0.885, "Cada ponto é uma rodada de 60 s; o traço é a mediana das 6 repetições", color=INK2, fontsize=9)
fig.tight_layout(rect=(0, 0, 1, 0.88))
salvar(fig, "03-p99-por-repeticao.png")

# ------------------------------------------------------------- 4. cobertura por fluxo
flu = pd.read_csv(os.path.join(BASE, "otel-100", "rep-1", "cobertura-fluxos.csv"))
flu = flu[flu.esperado.str.contains(r"\+")]  # so fluxos que atravessam outro servico
flu["rot"] = flu.protocolo + "  " + flu.fluxo.str.replace("/banco/soap/", "").str.replace("/banco/rest/", "")
fig, ax = plt.subplots(figsize=(9.5, 5.6))
ys = range(len(flu))
ax.barh(list(ys), flu.cobertura_pct, height=0.6, color=COR["otel-100"], edgecolor=SURF, linewidth=1)
for y, (_, r) in zip(ys, flu.iterrows()):
    if r.cobertura_pct >= 99.9:
        ax.text(r.cobertura_pct - 2, y, "100%", va="center", ha="right", fontsize=8.5, color="#ffffff")
    else:
        aus = r.ausentes.replace(" 100%", "")
        ax.text(2, y, f"0%   quebra antes de: {aus}", va="center", ha="left", fontsize=8.5, color=INK)
ax.set_yticks(list(ys), flu.rot)
ax.invert_yaxis()
ax.set_xlim(0, 100)
grade(ax)
ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x)}%"))
ax.set_xlabel("traces com todos os serviços esperados (OTel 100%)")
fig.suptitle("Cobertura de traces por fluxo: o contexto se perde nos saltos AMQP e TCP", x=0.01, ha="left",
             fontsize=13, fontweight="bold")
fig.text(0.01, 0.925, "Fluxos que atravessam mais de um serviço; resultado idêntico nas 6 repetições", color=INK2, fontsize=9)
fig.tight_layout(rect=(0, 0, 1, 0.92))
salvar(fig, "04-cobertura-por-fluxo.png")

# ------------------------------------------------------------- 5. recursos (sem dois eixos: dois paineis)
painel = [("container_gateway", "cpu_nucleos", "CPU do api-gateway", "núcleos", 2),
          ("projeto-dsd-jaeger-1", "mem_mb", "Memória do Jaeger", "MB", 0)]
fig, axes = plt.subplots(1, 2, figsize=(10, 4.4))
for ax, (srv, col, tit, un, casas) in zip(axes, painel):
    for i, cfg in enumerate(CFGS):
        d = rec[(rec.config == cfg) & (rec.servico == srv)][col]
        med = d.median()
        ax.bar(i, med, width=0.55, color=COR[cfg], edgecolor=SURF, linewidth=1)
        xs = [i + (j - (len(d) - 1) / 2) * 0.06 for j in range(len(d))]
        ax.scatter(xs, d, s=16, color=INK, alpha=0.55, zorder=3, linewidth=0)
        ax.text(i, max(med, d.max()) * 1.04, f"{br(med, casas)} {un}", ha="center", va="bottom", fontsize=9, color=INK)
    ax.set_xticks(range(3), [NOME[c] for c in CFGS])
    grade(ax, "y")
    lo, hi = ax.get_ylim(); ax.set_ylim(0, hi * 1.12)
    if col == "cpu_nucleos":
        ax.yaxis.set_major_locator(MultipleLocator(0.05))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda y, _, c=casas: br(y, c)))
    ax.set_title(tit)
    ax.set_ylabel(un)
fig.suptitle("Onde fica o custo de recursos", x=0.01, ha="left", fontsize=13, fontweight="bold")
fig.text(0.01, 0.885, "Barra = mediana; pontos = cada repetição. CPU média durante a rodada; memória ao fim da rodada",
         color=INK2, fontsize=9)
fig.tight_layout(rect=(0, 0, 1, 0.88))
salvar(fig, "05-recursos.png")
