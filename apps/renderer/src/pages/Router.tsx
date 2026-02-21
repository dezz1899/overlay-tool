import { Route, Routes } from "react-router-dom";
import { OverlayPage } from "./overlay";

export const Router = () => <Routes><Route path="/p/:profileId" element={<OverlayPage />} /></Routes>;
