import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FlightApp } from "./FlightApp.tsx";
import "../styles.css";
import "./flight.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FlightApp />
  </StrictMode>,
);
