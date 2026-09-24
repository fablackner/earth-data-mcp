# earth-data-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents live Earth
data: earthquakes, volcanoes, weather and warnings, air quality, sea state,
natural events, disaster alerts, space weather, and atmospheric CO2.

All upstream sources are public and unauthenticated, so the server needs no
API keys or configuration.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_earthquakes` | USGS earthquakes by magnitude, time window, and location radius. |
| `get_earthquake` | Full detail for one USGS event. |
| `search_volcanic_activity` | Current weekly volcanic activity report, filterable by volcano or country. |
| `get_weather` | Current conditions and daily forecast for a place or coordinates. |
| `get_lightning_risk` | Hourly thunderstorm/lightning risk. |
| `search_weather_alerts` | Official warnings (US NWS, or MeteoAlarm for Europe). |
| `get_air_quality` | AQI, pollutants, UV, and pollen (Europe). |
| `get_marine_conditions` | Waves, swell, sea temperature, and currents offshore. |
| `search_natural_events` | NASA EONET events: wildfires, storms, icebergs, dust, … |
| `search_disasters` | GDACS disaster alerts with humanitarian impact levels. |
| `get_space_weather` | NOAA storm scales, Kp, flares, and aurora outlook. |
| `get_co2_record` | Mauna Loa atmospheric CO2: latest month, yearly change, last 24 months. |

## Usage

```sh
bun install
bun run start      # stdio
bun run start:http # HTTP on $PORT (default 3000) at /mcp
```

Add it to Claude Code:

```sh
claude mcp add earth-data -- bun /absolute/path/to/earth-data-mcp/src/index.js
```

## Deploying

The HTTP mode is stateless, so it runs on any serverless host. The repo is set
up for Vercel:

```sh
bunx vercel deploy --prod    # → https://<project>.vercel.app/mcp
```

Other options: Cloudflare Workers or Deno Deploy (with their own entry point),
or Render / Fly.io running `bun run start:http`. Static hosts like GitHub Pages
won't work.

The deployed endpoint is public. That is fine here since it only proxies
read-only public data.

## Eval

`eval/` checks whether an agent picks the right tool, passes sensible
arguments, and reports answers that match the live upstream data.

```sh
ANTHROPIC_API_KEY=... bun run eval
MODEL=claude-opus-4-8 EFFORT=high RUNS=3 bun run eval
MOCK=1 bun run eval    # scripted agent, no API calls
```

Scoring is deterministic (no LLM judge), and ground truth is fetched at run
time. The command exits non-zero on failure.

## Data sources

- [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/fdsnws/event/1/)
- [Smithsonian Global Volcanism Program](https://volcano.si.edu/)
- [Open-Meteo](https://open-meteo.com/) forecast, geocoding, air quality, and marine APIs (CC BY 4.0; free tier is non-commercial)
- [US National Weather Service](https://www.weather.gov/documentation/services-web-api)
- [MeteoAlarm](https://meteoalarm.org/)
- [NASA EONET](https://eonet.gsfc.nasa.gov/)
- [GDACS](https://www.gdacs.org/)
- [NOAA Space Weather Prediction Center](https://www.swpc.noaa.gov/)
- [NOAA Global Monitoring Laboratory](https://gml.noaa.gov/ccgg/trends/)

## License

MIT
