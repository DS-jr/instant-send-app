import express from "express";
import { deleteContact, getContacts } from "../controllers/contactController";

const contactRoutes = express.Router();

contactRoutes.get("/", (req, res) => {
  res.send("Hello from the contact routes!");
});
contactRoutes.get("/getContacts/:id", getContacts);
contactRoutes.delete("/deleteContact/:id", deleteContact);

export default contactRoutes;
